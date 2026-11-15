import importlib.util
import tempfile
import unittest
from pathlib import Path
import h5py
import numpy as np
import rasterio
from pyproj import Transformer
spec=importlib.util.spec_from_file_location('drought_ingest',Path(__file__).with_name('ingest.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class PairTest(unittest.TestCase):
 def fixture(self, directory, date, power=1, track=105, offset=0):
  name=f'NISAR_L2_PR_GCOV_023_{track:03}_A_017_4005_DHDH_A_{date}T111906_{date}T111941_P05023_N_F_J_001.h5'
  path=Path(directory)/name
  with h5py.File(path,'w') as f:
   g=f.create_group('/science/LSAR/identification')
   values={'productType':'GCOV','trackNumber':track,'frameNumber':17,'orbitPassDirection':'Ascending','lookDirection':'Right','zeroDopplerStartTime':f'{date[:4]}-{date[4:6]}-{date[6:]}T11:19:06'}
   for k,v in values.items():g[k]=v
   g=f.create_group('/science/LSAR/GCOV/grids/frequencyA')
   g['xCoordinates']=500005+offset+np.arange(4)*10;g['yCoordinates']=3300035-np.arange(4)*10
   g['xCoordinateSpacing']=10.;g['yCoordinateSpacing']=-10.;g['projection']=32615
   for pol in ('HHHH','HVHV'):
    a=np.full((4,4),power,np.float32);a[0,0]=np.nan;g[pol]=a
  return path
 def test_real_reader_alignment_units_and_masks(self):
  with tempfile.TemporaryDirectory() as directory:
   a=self.fixture(directory,'20260621');b=self.fixture(directory,'20260901',power=10)
   convert=Transformer.from_crs(32615,4326,always_xy=True)
   west,south=convert.transform(500000,3300000);east,north=convert.transform(500040,3300040)
   manifest=module.ingest(a,b,(west,south,east,north),Path(directory)/'output')
   self.assertEqual(len(manifest['layers']),16)
   with rasterio.open(Path(directory)/'output/HH-change.tif') as source:
    values=source.read(1);self.assertTrue(np.isnan(values[0,0]));np.testing.assert_allclose(values[1:,1:],10)
   with rasterio.open(Path(directory)/'output/HH-common-valid.tif') as source:
    self.assertEqual(source.read(1)[0,0],0)
   with self.assertRaises(ValueError):module.ingest(a,b,(0,0,0,1),Path(directory)/'bad')
 def test_disjoint_coverage_and_missing_polarization_fail(self):
  with tempfile.TemporaryDirectory() as directory:
   a=self.fixture(directory,'20260621');b=self.fixture(directory,'20260901',offset=10000)
   convert=Transformer.from_crs(32615,4326,always_xy=True)
   west,south=convert.transform(500000,3300000);east,north=convert.transform(500040,3300040)
   with self.assertRaises(ValueError):module.ingest(a,b,(west,south,east,north),Path(directory)/'bad')
   with h5py.File(a,'r+') as f:del f['/science/LSAR/GCOV/grids/frequencyA/HVHV']
   with self.assertRaises(KeyError):module.ingest(a,b,(west,south,east,north),Path(directory)/'bad2',bands=('HV',))
 def test_incompatible_geometry_rejected(self):
  with tempfile.TemporaryDirectory() as directory:
   a=self.fixture(directory,'20260621');b=self.fixture(directory,'20260901',track=106)
   with h5py.File(a) as first,h5py.File(b) as last:
    with self.assertRaisesRegex(ValueError,'track'):module.identities(first,last,(a,b))
if __name__=='__main__':unittest.main()
