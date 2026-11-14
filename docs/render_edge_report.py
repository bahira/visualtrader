"""Render a French motion report from a frozen snapshot of the local paper results."""

import argparse
from collections import OrderedDict
from functools import lru_cache
import json
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 720, 24
BG, FG = '#101721', '#edf6fa'
MUTED, MINT, RED, GOLD = '#a9bcc9', '#89edc2', '#f7a69e', '#f7cf84'


@lru_cache
def font(size, bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/'+('segoeuib.ttf' if bold else 'segoeui.ttf'),size)


def number(value, decimals=2):
    return f'{value:+.{decimals}f}'.replace('-', '−').replace('.', ',')


def backdrop():
    image = Image.new('RGB',(W,H),BG)
    d = ImageDraw.Draw(image)
    for y in range(H):
        d.line((0,y,W,y),fill=(16,23+int(10*y/H),33+int(11*y/H)))
    for x in range(64,W,32):
        for y in range(108,667,32):
            d.point((x,y),fill='#436075')
    return image


BASE = backdrop()


def render(t, series, metadata):
    scenes = (7,8,10,9,7)
    scene = 0
    while t>=scenes[scene] and scene<len(scenes)-1:
        t-=scenes[scene]
        scene+=1
    local = min(1,t/scenes[scene])
    ease = 1-(1-min(1,t/1.25))**3
    frame = BASE.copy()
    d = ImageDraw.Draw(frame)

    def text(x,y,value,size=28,color=FG,bold=False):
        d.text((x,y),value,font=font(size,bold),fill=color)

    def panel(bounds,fill='#1b2b3a'):
        d.rounded_rectangle(bounds, radius=16, fill=fill, outline='#33495e',width=1)

    title_y = 140 + int(25*(1-ease))
    text(64,44,'VISUALTRADER   /   RAPPORT PAPER',23,MINT,True)
    d.line((64,95,1216,95),fill='#385268',width=1)
    d.line((64,658,1216,658),fill='#3c4d61',width=2)
    d.line((64,658,64+int((scene+local)*1152/len(scenes)),658),fill=MINT,width=3)
    text(64,674,metadata['stamp'],17,MUTED)
    text(1125,672,f'{scene+1:02d} / 05',18,MUTED,True)

    if scene==0:
        text(64,title_y,'Combien ça rapporte ?',57,FG,True)
        text(64,225,'BTC Up / Down · Polymarket · Simulation',25,MUTED)
        panel((64,315,1216,575))
        text(93,348,'ESTIMATION EN EUROS',21,GOLD,True)
        text(93,393,'Échantillon insuffisant',46,FG,True)
        for i,label in enumerate(('PAR HEURE','PAR JOUR','SUR 30 JOURS')):
            text(93+364*i,488,'—   '+label,24,MUTED,True)
    elif scene==1:
        text(64,title_y,'Le résultat observé',55,FG,True)
        text(64,221,'Quant Skew · positions simulées réglées · frais inclus',25,MUTED)
        text(64,278,number(metadata['net']*ease)+' €',87,RED if metadata['net']<0 else MINT,True)
        for i,(label,value) in enumerate((('FILLS RÉGLÉS',str(metadata['fills'])),
                                          ('MARCHÉS RÉGLÉS',str(metadata['markets'])),
                                          ('BRIER CARNET',f"{metadata['book']:.3f}"))):
            x = 64+388*i
            panel((x,478,x+363,590))
            text(x+20,495,label,17,MUTED,True)
            text(x+20,525,value,33,FG,True)
        text(65,616,'Conversion indicative BCE du 13/11/2026 · 1 USDC ≈ 1 USD',18,MUTED)
    elif scene==2:
        text(64,title_y,'Ce que 250 ms changent',51,FG,True)
        text(64,215,f"Impulsion Binance · {metadata['sample']} marchés historiques comparables",25,MUTED)
        scale = max(1,*(abs(v[1]) for v in series.values()))
        for i,(delay,(count,pnl)) in enumerate(series.items()):
            y = 300+i*95
            text(66,y,f'{delay} ms',30,FG,True)
            fraction = max(.003,abs(pnl)/scale*ease)
            d.rounded_rectangle((270,y+7,274+int(580*fraction),y+29),radius=8,fill=MINT if pnl>=0 else RED)
            text(930,y,number(pnl)+' USDC',26,FG,True)
            text(930,y+35,f'{count} fill'+('s' if count!=1 else ''),18,MUTED)
        text(64,605,'Un fill historique suffit à déplacer le résultat. Il faut le reproduire.',22,GOLD)
    elif scene==3:
        text(64,title_y,'Du signal à la preuve',55,FG,True)
        text(64,221,'Un test clonable, du journal de marché à la comparaison.',24,MUTED)
        cards = [('01','Croiser','Flux spot Binance','Carnet et règlements'),('02','Rejouer','250 · 500 · 1 000 ms','Frais et taille observée'),
                 ('03','Comparer','Indicateurs seuls / ensemble','UP, DOWN et volatilité')]
        for i,(n,title,a,b) in enumerate(cards):
            x = 64+388*i
            y = 320+int(25*(1-min(1,max(0,(t-i*.25)/1.25))))
            panel((x,y,x+363,y+226))
            text(x+20,y+17,n,23,MINT,True)
            text(x+20,y+58,title,35,FG,True)
            text(x+20,y+125,a,22,MUTED)
            text(x+20,y+163,b,22,MUTED)
    else:
        text(64,title_y,'Le prochain verdict',55,FG,True)
        text(64,226,'Collecte prospective · protocole figé',25,MUTED)
        panel((64,313,1216,570))
        text(92,340,'30 FILLS MINIMUM',21,GOLD,True)
        text(92,385,'10 JOURS AVEC FILLS',21,GOLD,True)
        text(92,430,'95 % DE COUVERTURE',21,GOLD,True)
        text(92,495,'Clôture du bloc le 28 novembre à 21 h 10 (Paris)',30,FG,True)
    return frame


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path)
    parser.add_argument('--preview',type=Path)
    args = parser.parse_args()
    status = json.loads(Path('data/polymarket-v2/status.json').read_text(encoding='utf8'))
    result = json.loads(Path('data/polymarket-v2/spot-benchmark.json').read_text(encoding='utf-8-sig'))
    old = result['benchmark']['prior']
    series = OrderedDict((delay,(old[str(delay)]['impulse']['fills'],old[str(delay)]['impulse']['stressNet']))
                         for delay in (250,500,1000))
    meta = {'stamp':'Mesures du '+status['checked'][:10]+' · Polymarket BTC 5 min',
            'net':status['summary']['skew']['net']/1.1052, 'fills':status['summary']['skew']['settled'],
            'markets':status['resolved'],'book':status['summary']['market']['brier'],
            'sample':old['500']['impulse']['markets']}
    if args.preview:
        render(2,series,meta).save(args.preview)
    command = ['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24',
               '-video_size',f'{W}x{H}','-framerate',str(FPS),'-i','-',
               '-f','lavfi','-i','sine=frequency=110:sample_rate=48000',
               '-af','volume=0.14,tremolo=f=3:d=0.65,afade=t=in:st=0:d=2,afade=t=out:st=37:d=4',
               '-shortest','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',
               '-c:a','aac','-b:a','96k','-movflags','+faststart',str(args.output)]
    with subprocess.Popen(command,stdin=subprocess.PIPE) as encoder:
        with encoder.stdin:
            for f in range(41*FPS):
                encoder.stdin.write(render(f/FPS,series,meta).tobytes())
        if encoder.wait():
            raise SystemExit('FFmpeg encoding failed')


if __name__ == '__main__':
    main()
