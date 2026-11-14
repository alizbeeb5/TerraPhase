from io import BytesIO
import json
import math

from fastapi.testclient import TestClient
import numpy as np
from PIL import Image
from pyproj import Transformer
import pytest
import rasterio
from rasterio.transform import from_bounds

from nisar_backend.api import create_app
from nisar_backend.regions import export_crop, parse_bbox, read_region_power, region_info, mercator_bounds
from nisar_backend.render import render_tile, WEB_MERCATOR_LIMIT
from nisar_backend import terrain
from tests.test_backend import prepared


def small_bbox(directory):
    with rasterio.open(directory / 'frequencyA_HHHH.tif') as source:
        transform = Transformer.from_crs(source.crs, 4326, always_xy=True)
        a = transform.transform(*source.xy(650, 350))
        b = transform.transform(*source.xy(350, 650))
    return (a[0], a[1], b[0], b[1])


@pytest.mark.parametrize('value',['nan,0,1,1','0,0,0,1','1,0,0,1','0,-90,1,1','0,0,1','170,0,-170,1'])
def test_invalid_selection_rejected(value):
    with pytest.raises(ValueError):
        parse_bbox(value)


def test_region_and_native_export_preserve_measurements(prepared,tmp_path):
    _, _, directory, _ = prepared
    cog = directory / 'frequencyA_HHHH.tif'
    manifest = json.loads((directory/'scene.json').read_text())
    bounds=small_bbox(directory)
    region=region_info(cog,bounds,manifest['footprint'])
    assert region['crop_download_available']
    assert 200 < region['native_width'] < 400
    path=export_crop(cog,bounds,tmp_path/'exports')
    with rasterio.open(path) as crop, rasterio.open(cog) as original:
        assert crop.res==original.res
        assert crop.crs==original.crs
        assert crop.tags(ns='IMAGE_STRUCTURE')['LAYOUT']=='COG'
        values=crop.read(1)
        rr,cc=np.indices(values.shape)
        xx=crop.transform.c+(cc+.5)*crop.transform.a
        yy=crop.transform.f+(rr+.5)*crop.transform.e
        lon,lat=Transformer.from_crs(crop.crs,4326,always_xy=True).transform(xx,yy)
        inside=(lon>=bounds[0])&(lon<bounds[2])&(lat>bounds[1])&(lat<=bounds[3])
        row0,col0=original.index(*crop.xy(0,0))
        expected=original.read(1,window=rasterio.windows.Window(col0,row0,crop.width,crop.height))
        expected[~inside]=np.nan
        np.testing.assert_array_equal(values,expected)
        assert np.isfinite(values).any() and np.isnan(values).any()
    sample=read_region_power(cog,bounds,80,96)
    assert sample.shape==(96,80)
    assert sample[-5:,-5:].mean()>sample[:5,:5].mean()
    with pytest.raises(ValueError,match='coverage'):
        region_info(cog,(0,0,1,1),manifest['footprint'])


def test_clipped_tiles_do_not_show_outside_selection(prepared):
    _,_,directory,_=prepared
    cog=directory/'frequencyA_HHHH.tif'
    bounds=small_bbox(directory)
    x,y=Transformer.from_crs(4326,3857,always_xy=True).transform((bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2)
    z=13;span=2*WEB_MERCATOR_LIMIT/2**z
    tx,ty=math.floor((x+WEB_MERCATOR_LIMIT)/span),math.floor((WEB_MERCATOR_LIMIT-y)/span)
    normal=np.asarray(Image.open(BytesIO(render_tile(cog,z,tx,ty,-30,0,'gray'))))
    clipped=np.asarray(Image.open(BytesIO(render_tile(cog,z,tx,ty,-30,0,'gray',bounds))))
    visible=clipped[...,3]>0
    assert visible.any() and (~visible).any()
    np.testing.assert_array_equal(clipped[visible],normal[visible])


def test_terrarium_decode_and_continuous_mosaic(monkeypatch,tmp_path):
    heights=np.array([[0.,125.5,-100.,12000.25]],dtype=np.float64)
    encoded=heights+32768
    pixels=np.stack((np.floor(encoded/256),np.floor(encoded)%256,np.round((encoded%1)*256),np.full_like(encoded,255)),axis=-1).astype(np.uint8)
    np.testing.assert_array_equal(terrain.decode_terrarium(pixels),heights)
    pixels[0,0,3]=0
    assert np.isnan(terrain.decode_terrarium(pixels)[0,0])
    def tile(cache,z,x,y):
        # Elevation increases in global pixel coordinates across tile boundaries.
        yy,xx=np.indices((256,256))
        return (x*256+xx)*.25+(y*256+yy)*.5
    monkeypatch.setattr(terrain,'fetch_tile',tile)
    bounds=(-79.85,9.05,-79.55,9.35)
    result,_=terrain.public_dem(bounds,65,tmp_path)
    z,_,(x0,y0,x1,y1)=terrain.tile_plan(bounds,65)
    xx,yy=np.meshgrid(np.linspace(x0,x1,65),np.linspace(y0,y1,65))
    np.testing.assert_allclose(result,xx*.25+yy*.5,rtol=1e-7)


def test_local_dem_and_texture_share_extent(prepared,tmp_path,monkeypatch):
    _,catalog,directory,_=prepared
    bounds=small_bbox(directory)
    left,bottom,right,top=mercator_bounds(bounds)
    dx=(right-left)/128;dy=(top-bottom)/128
    dem_path=tmp_path/'dem.tif'
    transform=from_bounds(left-dx,bottom-dy,right+dx,top+dy,131,131)
    rr,cc=np.indices((131,131));elevation=(100+cc*.2+rr*.4).astype('float32')
    with rasterio.open(dem_path,'w',driver='GTiff',width=131,height=131,count=1,dtype='float32',crs='EPSG:3857',transform=transform) as dem:
        dem.write(elevation,1)
    monkeypatch.setenv('GCOV_DEM_PATH',str(dem_path))
    with TestClient(create_app(catalog)) as client:
        base='/api/scenes/sample/layers/frequencyA_HHHH/'
        query={'bbox':','.join(map(str,bounds))}
        assert client.get(base+'region',params=query).status_code==200
        response=client.get(base+'terrain',params={**query,'grid':129})
        assert response.status_code==200,response.text
        data=response.json()
        assert data['rows']==data['columns']==129
        assert data['bbox']==list(bounds)
        np.testing.assert_allclose(data['extent_mercator'],[left,bottom,right,top])
        grid=np.asarray(data['elevation_m']).reshape(129,129)
        assert grid[-1,-1]>grid[0,0]
        texture=client.get(base+'texture.png',params={**query,'size':256})
        assert texture.status_code==200
        assert max(Image.open(BytesIO(texture.content)).size)==256
        assert client.get(base+'terrain',params={**query,'grid':128}).status_code==422
        assert client.get(base+'region',params={'bbox':'0,0,1,1'}).status_code==422
        cropped=client.get(base+'crop.tif',params=query,headers={'Range':'bytes=0-15'})
        assert cropped.status_code==206
    # DEM failures must remain errors, not a synthesized terrain field.
    def failure(*args,**kwargs):
        raise terrain.TerrainUnavailable('DEM offline')
    monkeypatch.delenv('GCOV_DEM_PATH')
    monkeypatch.setattr(terrain,'public_dem',failure)
    with pytest.raises(terrain.TerrainUnavailable,match='offline'):
        terrain.terrain_grid(bounds,65,tmp_path)
