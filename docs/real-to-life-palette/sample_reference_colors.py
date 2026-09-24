"""Samples tissue colors from dissection figures for the Real-to-life palette.
See README.md in this folder for the method."""
import json, numpy as np
from PIL import Image, ImageDraw, ImageFont
import sys
# Usage: sample_reference_colors.py <figures dir> <output dir>
# The figures dir holds the page images as 25.webp (Fig 3.9), 26.webp (Fig 3.12)
# and 27.webp (Fig 3.19). Requires numpy and Pillow.
IMG=sys.argv[1]
OUT=sys.argv[2]
imgs={n: np.asarray(Image.open(f'{IMG}/{n}.webp').convert('RGB')).astype(np.float64) for n in (25,26,27)}
FIG={25:'Fig. 3.9',26:'Fig. 3.12',27:'Fig. 3.19'}
# White references (white foam) -> per-channel gains; None = uncorrected.
WHITE={25:[(220,200,400,300),(1250,200,1350,300)], 27:[(860,250,960,330),(870,975,940,1005)]}
def region(n,r):
    x0,y0,x1,y1=r; return imgs[n][y0:y1,x0:x1].reshape(-1,3)
def robust(px):
    px=px[px.min(axis=1)<245]  # ignore page background around cut-out figures
    lum=px@[0.2126,0.7152,0.0722]
    lo,hi=np.percentile(lum,[5,85])  # drop deep shadow and glare
    keep=(lum>=lo)&(lum<=hi)
    return np.median(px[keep],axis=0)
# White foam under lab lighting, as it would photograph when exposed right.
FOAM_WHITE=235.0
gains={}
for n,rs in WHITE.items():
    w=np.median(np.concatenate([region(n,r) for r in rs]),axis=0)
    gains[n]=FOAM_WHITE/w  # foam -> near-white: corrects tint and exposure
# (tissue class, figure, rect, note)
S=[
 ('gill',25,(390,460,470,560),'g/gl, left gill'),
 ('gill',25,(980,420,1060,520),'g/gl, right gill'),
 ('gill',27,(160,560,240,640),'g, in situ (a)'),
 ('gill vessel',25,(355,440,395,520),'egv, left'),
 ('gill vessel',25,(1150,470,1190,560),'egv, right'),
 ('branchial heart',25,(360,790,430,850),'bh, left'),
 ('branchial heart',25,(1070,720,1110,790),'bh, right'),
 ('systemic heart',25,(850,625,885,655),'sh ventricle'),
 ('aorta / vessels',25,(792,300,802,420),'da, dorsal aorta'),
 ('digestive gland',26,(760,480,830,560),'dg'),
 ('digestive gland',26,(800,430,840,470),'dg, upper'),
 ('ink sac',26,(880,740,940,785),'ins'),
 ('posterior salivary gland',26,(650,480,690,540),'psg, upper'),
 ('posterior salivary gland',26,(470,640,520,720),'psg, lower'),
 ('buccal mass',26,(545,480,600,530),'bm'),
 ('crop / oesophagus',26,(610,720,650,790),'cr'),
 ('stomach',26,(860,1060,910,1130),'st'),
 ('caecum',26,(1000,1040,1060,1090),'cae'),
 ('intestine',26,(1240,600,1310,760),'int'),
 ('testis',27,(850,820,1000,900),'te (b)'),
 ('testis',27,(320,830,400,880),'te, in situ (a)'),
 ('spermatophoric gland',27,(985,660,1015,720),'spgl (b)'),
 ('spermatophoric (Needham\'s) sac',27,(1035,350,1065,420),'spss (b)'),
 ('spermatophoric sac gland',27,(1150,500,1175,530),'spsg (b)'),
 ('terminal organ',27,(1055,230,1080,260),'to (b)'),
]
samples=[]
for cls,n,r,note in S:
    raw=robust(region(n,r))
    # fig 27 (a) is a different photo (tray, no foam): only (b) crops are corrected
    corrected = n in gains and not (n==27 and r[0]<700)
    wb=np.clip(raw*gains[n],0,255) if corrected else raw
    samples.append(dict(cls=cls,fig=FIG[n],img=n,rect=r,note=note,raw=raw.round().tolist(),color=wb.round().tolist(),white_balanced=bool(corrected)))
classes={}
for s in samples: classes.setdefault(s['cls'],[]).append(s)
palette={c:np.median([s['color'] for s in v],axis=0).round().tolist() for c,v in classes.items()}
json.dump(dict(samples=samples,palette=palette),open(f'{OUT}/samples.json','w'),indent=1)
for c,v in palette.items(): print(f"{c:32s} #{int(v[0]):02x}{int(v[1]):02x}{int(v[2]):02x}  from {len(classes[c])} sample(s)")
