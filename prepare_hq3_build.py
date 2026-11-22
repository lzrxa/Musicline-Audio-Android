#!/usr/bin/env python3
"""Download, verify and install MDX Inst HQ3 into Musicline Offline Android Studio project.
This does not implement AI inference; it only stages verified ONNX weights.
"""
import argparse, hashlib, os, shutil, sys, urllib.request
from pathlib import Path
EXPECTED_SHA = '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc'
FILE_NAME = 'UVR-MDX-NET-Inst_HQ_3.onnx'
URLS = [
    'https://huggingface.co/Anjok/model-repo/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx',
    'https://huggingface.co/masszhou/mdxnet/resolve/main/UVR-MDX-NET-Inst_HQ_3.onnx',
]
def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(4*1024*1024),b''):
            h.update(block)
    return h.hexdigest()
def main():
    ap=argparse.ArgumentParser(description='Stage verified MDX Inst HQ3 weight file')
    ap.add_argument('--model-file',type=Path,help='Use previously downloaded ONNX file instead of internet')
    ap.add_argument('--project',type=Path,default=Path(__file__).resolve().parent/'Musicline_Audio_Offline_AndroidStudio')
    args=ap.parse_args()
    dest=args.project/'app/src/main/assets/www/models'/FILE_NAME
    dest.parent.mkdir(parents=True,exist_ok=True)
    tmp=dest.with_suffix('.onnx.partial')
    if args.model_file:
        if not args.model_file.is_file():sys.exit('Cannot find input model file: '+str(args.model_file))
        shutil.copyfile(args.model_file,tmp)
    else:
        for url in URLS:
            try:
                print('Trying:',url,flush=True)
                with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Musicline-Offliner/1.0'}),timeout=45) as resp, tmp.open('wb') as out:
                    shutil.copyfileobj(resp,out,length=4*1024*1024)
                if tmp.stat().st_size < 60_000_000:raise ValueError('Downloaded file unexpectedly small')
                if sha256(tmp)!=EXPECTED_SHA:raise ValueError('SHA-256 mismatch; possibly wrong model revision')
                break
            except Exception as e:
                print('Download failed:', e, file=sys.stderr)
                tmp.unlink(missing_ok=True)
        else:sys.exit('Could not download the model. Use --model-file to import it manually.')
    size=tmp.stat().st_size
    digest=sha256(tmp)
    print('Size:',size,'bytes')
    print('SHA-256:',digest)
    if digest!=EXPECTED_SHA:
        tmp.unlink(missing_ok=True)
        sys.exit('Model checksum mismatch. Refusing to install.')
    os.replace(tmp,dest)
    print('VERIFIED and STAGED:',dest)
    print('NOTICE: A complete offline APK also needs a bundled ONNX runtime + audio separation pipeline.')
if __name__=='__main__':main()
