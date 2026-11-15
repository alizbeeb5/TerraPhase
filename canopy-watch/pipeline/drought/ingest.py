"""Reusable bounded GCOV repeat-pass ingestion; raw inputs remain outside Git."""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import h5py
import numpy as np
import rasterio
from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
from gcov_product import read_layer, identification, scalar
from export_comparison import scene_metadata, aligned_layer, CHANNELS


def identities(first, last, paths):
    result = [scene_metadata(Path(path)) for path in paths]
    if result[0]['date'] >= result[1]['date']:
        raise ValueError('Before acquisition must precede after acquisition')
    for key in ('track', 'pass', 'frame', 'bandwidth', 'polarization', 'release'):
        if result[0][key] != result[1][key]:
            raise ValueError('Incompatible repeat pass: ' + key)
    metadata = [identification(f) for f in (first, last)]
    for index, (f, meta) in enumerate(zip((first, last), metadata)):
        for key, expected in (('productType', 'GCOV'), ('trackNumber', int(result[index]['track'])),
                              ('frameNumber', int(result[index]['frame']))):
            if meta.get(key) != expected:
                raise ValueError('Missing or inconsistent HDF5 metadata: ' + key)
        direction = str(meta.get('orbitPassDirection', '')).lower()
        if not direction.startswith(result[index]['pass'].lower()):
            raise ValueError('HDF5 pass direction disagrees with filename')
        if meta.get('zeroDopplerStartTime', '')[:19] != result[index]['date'][:19]:
            raise ValueError('HDF5 acquisition time disagrees with filename')
        look_path = '/science/LSAR/identification/lookDirection'
        if look_path not in f:
            raise ValueError('Missing look direction; geometry cannot be verified')
        result[index]['lookDirection'] = scalar(f[look_path][()])
        result[index]['identification'] = meta
        result[index]['fileName'] = Path(paths[index]).name
        result[index]['sizeBytes'] = Path(paths[index]).stat().st_size
    if result[0]['lookDirection'] != result[1]['lookDirection']:
        raise ValueError('Look directions must match')
    return result


def ingest(before, after, bbox, output, bands=('HH', 'HV'), max_pixels=4_000_000):
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
        raise ValueError('Expected valid WGS84 study-area bounds')
    if not bands or any(b not in CHANNELS for b in bands):
        raise ValueError('Select HH and/or HV')
    if max_pixels < 1 or max_pixels > 4_000_000:
        raise ValueError('Maximum output size is 4 million pixels')
    output = Path(output)
    with h5py.File(before, 'r') as first, h5py.File(after, 'r') as last:
        sources = identities(first, last, (before, after))
        path = '/science/LSAR/GCOV/grids/frequencyA/' + CHANNELS[bands[0]]
        anchor = read_layer(first, path)
        box = transform_bounds('EPSG:4326', anchor.crs, *bbox, densify_pts=21)
        window = from_bounds(*box, transform=anchor.transform).round_offsets().round_lengths()
        rows, cols = int(window.height), int(window.width)
        if min(rows, cols) < 1 or rows * cols > max_pixels:
            raise ValueError('Study area empty or exceeds bounded output size')
        transform = anchor.transform * rasterio.Affine.translation(window.col_off, window.row_off)
        bounds = array_bounds(rows, cols, transform)
        prepared = []
        for band in bands:
            layer_path = '/science/LSAR/GCOV/grids/frequencyA/' + CHANNELS[band]
            for source in (first, last):
                layer = read_layer(source, layer_path)
                if layer.crs != anchor.crs or abs(layer.transform.a-anchor.transform.a)>1e-6 or abs(layer.transform.e-anchor.transform.e)>1e-6:
                    raise ValueError('Repeat scenes require matching projection and native spacing')
            powers = [aligned_layer(f, band, bounds, anchor.crs, transform, (rows, cols)) for f in (first, last)]
            masks = [np.isfinite(a) & (a > 0) for a in powers]
            common = masks[0] & masks[1]
            if not common.any():
                raise ValueError('No overlapping valid data for ' + band)
            prepared.append((band, powers, masks, common))
        output.mkdir(parents=True, exist_ok=True)
        assets = []
        def save(name, array, measurement, units, dtype='float32'):
            nodata = None if dtype == 'uint8' else float('nan')
            with rasterio.open(output / name, 'w', driver='GTiff', height=rows, width=cols, count=1,
                               dtype=dtype, crs=anchor.crs, transform=transform, nodata=nodata, compress='deflate') as dst:
                dst.write(array.astype(dtype), 1)
                dst.update_tags(measurement=measurement, units=units)
            assets.append({'path': name, 'measurement': measurement, 'units': units,
                           'sha256': hashlib.sha256((output/name).read_bytes()).hexdigest()})
        for band, powers, masks, common in prepared:
            dbs=[]
            for index, side in enumerate(('before', 'after')):
                power=powers[index]; db=np.full(power.shape,np.nan,np.float32)
                np.log10(power, out=db, where=masks[index]); db *= 10; dbs.append(db)
                save(f'{band}-{side}-power.tif',power,'Terrain-corrected gamma0 backscatter','1')
                save(f'{band}-{side}-db.tif',db,'10 log10(gamma0 backscatter)','dB')
                save(f'{band}-{side}-valid.tif',masks[index],'Valid source data (1 valid, 0 invalid)','1','uint8')
            delta=dbs[1]-dbs[0];delta[~common]=np.nan
            save(f'{band}-change.tif',delta,'After minus before gamma0 backscatter','dB')
            save(f'{band}-common-valid.tif',common,'Shared valid data (1 valid, 0 invalid)','1','uint8')
    manifest={'schema':'terraphase-gcov-pair/v1','sources':sources,'studyAreaWgs84':list(bbox),
              'grid':{'crs':anchor.crs.to_string(),'transform':list(transform)[:6], 'width':cols,'height':rows,'bounds':list(bounds)},
              'layers':assets,'resampling':'Average linear power before conversion to dB; full valid coverage required',
              'capabilities':{'forecast':False,'soilMoisture':False},
              'limitations':['GCOV is radar backscatter, not soil moisture or drought classification.']}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    return manifest

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before'); parser.add_argument('after')
    parser.add_argument('--bbox',nargs=4,type=float,required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args();ingest(args.before,args.after,args.bbox,args.output)
