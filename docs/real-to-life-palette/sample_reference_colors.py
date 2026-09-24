"""Samples tissue colors from dissection figures for the Real-to-life palette.
See README.md in this folder for the method."""
import json, numpy as np
from PIL import Image, ImageDraw, ImageFont
import sys
# Usage: sample_reference_colors.py <figures dir> <output dir>
# The figures dir holds the page images as 25.webp (Fig 3.9), 26.webp (Fig 3.12),
# 27.webp (Fig 3.19), 28.png (cephalopod brain, dark-field photo; Nixon & Young,
# The Brains and Lives of Cephalopods), 29.webp (Fig 3.19 at higher resolution,
# for the renal tissue in panel a) and 30.webp (O. vulgaris upper beak).
# Requires numpy and Pillow.
IMG=sys.argv[1]
OUT=sys.argv[2]
FILES={25:'25.webp',26:'26.webp',27:'27.webp',28:'28.png',29:'29.webp',30:'30.webp'}
imgs={n: np.asarray(Image.open(f'{IMG}/{f}').convert('RGB')).astype(np.float64) for n,f in FILES.items()}
FIG={25:'Fig. 3.9',26:'Fig. 3.12',27:'Fig. 3.19',28:'Nixon & Young brain photo (b)',29:'Fig. 3.19a (hi-res)',30:'Upper beak photo'}
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
 ('brain',28,(155,410,195,450),'supraoesophageal mass'),
 ('brain',28,(95,395,130,440),'optic lobe, left (cream part)'),
 ('brain',28,(215,395,250,435),'optic lobe, right (cream part)'),
 ('renal tissue',29,(235,745,290,790),'renal, left of testis'),
 ('renal tissue',29,(450,775,500,805),'renal, right of testis'),
 ('renal tissue',29,(520,790,560,830),'renal, near right bh'),
 ('beak',30,(400,250,500,330),'upper beak body'),
 ('beak',30,(650,170,690,210),'hood'),
 ('beak',30,(430,570,500,620),'lateral wall (section)'),
]
# Photos without a white reference but showing a tissue already measured
# white-balanced elsewhere: per-channel gains mapping that tissue onto its
# measured color calibrate the rest of the photo. Fig 3.19a (tray lighting)
# is calibrated against its gills (gill measured in Fig 3.9).
CALIBRATE={29:('gill',25,(130,540,200,620))}
samples=[]
for cls,n,r,note in S:
    raw=robust(region(n,r))
    # fig 27 (a) is a different photo (tray, no foam): only (b) crops are corrected
    corrected = n in gains and not (n==27 and r[0]<700)
    wb=np.clip(raw*gains[n],0,255) if corrected else raw
    calibrated=None
    if n in CALIBRATE:
        ref_cls,ref_img,ref_rect=CALIBRATE[n]
        measured=np.median([robust(region(i,rr))*gains[i] for c,i,rr,_ in S if c==ref_cls and i==ref_img],axis=0)
        cal_gains=measured/robust(region(n,ref_rect))
        wb=np.clip(raw*cal_gains,0,255)
        calibrated=f'{ref_cls} ({FIG[ref_img]})'
    samples.append(dict(cls=cls,fig=FIG[n],img=n,rect=r,note=note,raw=raw.round().tolist(),color=wb.round().tolist(),white_balanced=bool(corrected),calibrated_to=calibrated))
# Organs -> general tissue classes (what the app's palette uses): colors
# are for a kind of tissue, not a species' particular organ.
GENERAL={
 'brain':'nervous','gill':'gill','gill vessel':'vessel','aorta / vessels':'vessel',
 'systemic heart':'heart','branchial heart':'branchialHeart','digestive gland':'digestiveGland',
 'ink sac':'pigmented','posterior salivary gland':'exocrineGland','buccal mass':'muscle',
 'crop / oesophagus':'gutWall','caecum':'gutWall','intestine':'gutWall','stomach':'stomach',
 'testis':'gonad','spermatophoric gland':'reproductiveTract',"spermatophoric (Needham's) sac":'reproductiveTract',
 'spermatophoric sac gland':'reproductiveTract','terminal organ':'reproductiveTract',
 'renal tissue':'renal','beak':'beak',
}
groups={}
for s in samples: groups.setdefault(GENERAL[s['cls']],[]).append(s)
palette={}
for g,v in groups.items():
    # Prefer white-balanced samples; in-situ/uncorrected ones only if none.
    use=[s for s in v if s['white_balanced'] or s.get('calibrated_to')] or v
    col=np.median([s['color'] for s in use],axis=0).round().astype(int).tolist()
    palette[g]=dict(color=col,hex='#%02x%02x%02x'%tuple(col),white_balanced=any(s['white_balanced'] for s in use),
                    calibrated_to=next((s['calibrated_to'] for s in use if s.get('calibrated_to')),None),
                    samples=len(use),organs=sorted({s['cls'] for s in use}),figures=sorted({s['fig'] for s in use}))
json.dump(dict(samples=samples,palette=palette),open(f'{OUT}/samples.json','w'),indent=1)
for g,v in palette.items(): print(f"{g:20s} {v['hex']}  {'WB ' if v['white_balanced'] else 'raw'} n={v['samples']}  {', '.join(v['organs'])}")
