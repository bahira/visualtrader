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
OPTIONAL_SCENES = ('exit_marks','capacity','pressure','robustness','thresholds')


def render(t, series, metadata):
    scenes = (7,8,10,9)
    optional = [name for name in OPTIONAL_SCENES if metadata.get(name)]
    scenes += (8,)*len(optional)
    scenes += (7,)
    scene = 0
    while t>=scenes[scene] and scene<len(scenes)-1:
        t-=scenes[scene]
        scene+=1
    local = min(1,t/scenes[scene])
    current = optional[scene-4] if 4<=scene<4+len(optional) else None
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
    text(1125,672,f'{scene+1:02d} / {len(scenes):02d}',18,MUTED,True)

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
    elif current=='exit_marks':
        text(64,title_y,'Et si on revend ?',55,FG,True)
        text(64,221,'Même fill Impulsion · entrée simulée à 250 ms',24,MUTED)
        for i,(label,value) in enumerate(metadata['exit_marks']):
            x = 64+290*i
            panel((x,315,x+270,465))
            text(x+19,338,label,25,MUTED,True)
            text(x+19,388,'—' if value is None else number(value*ease)+' USDC',32,
                 MUTED if value is None else MINT if value>=0 else RED,True)
        text(64,529,'Revente de 10 parts au bid, frais d’aller-retour et stress inclus.',23,MUTED)
        text(64,577,'Une seule entrée observée. Les sorties sont des scénarios alternatifs.',23,GOLD)
    elif current=='capacity':
        text(64,title_y,'Combien de parts ?',55,FG,True)
        text(64,221,'Impulsion · même carnet d’entrée, revente après 15 s',24,MUTED)
        for i,(size,value,status) in enumerate(metadata['capacity']):
            x = 64+232*i
            panel((x,315,x+216,471))
            text(x+17,339,f'{size} parts',24,MUTED,True)
            text(x+17,391,number(value*ease)+' USDC' if value is not None else status,22,
                 GOLD if value is None else MINT if value>=0 else RED,True)
        text(64,526,'Chaque taille est rejouée indépendamment avec la marge initiale.',23,MUTED)
        text(64,572,'Un seul fill historique. La capacité varie avec le carnet.',23,GOLD)
    elif current=='pressure':
        text(64,title_y,'Le carnet ajoute-t-il un signal ?',48,FG,True)
        n, total, fills, rows = metadata['pressure']
        comparable = 'marché comparable' if n==1 else 'marchés comparables'
        text(64,221,f'{n} {comparable} sur {total} · Brier à 500 ms · plus bas = mieux',24,MUTED)
        largest = max(value for _,value in rows) or 1
        best = min(value for _,value in rows)
        for i,(label,value) in enumerate(rows):
            y = 293+55*i
            text(64,y,label,23,FG,True)
            color = MINT if value==best else GOLD
            d.rounded_rectangle((405,y+8,410+int(535*value/largest*ease),y+26),radius=5,fill=color)
            text(979,y,f'{value:.5f}'.replace('.',','),23,color,True)
        fill_label = 'exécution simulée' if fills<=1 else 'exécutions simulées'
        text(64,601,f'{fills} {fill_label} sur les cinq variantes à 500 ms.',22,MUTED)
    elif current=='robustness':
        text(64,title_y,'Le poids du meilleur fill',51,FG,True)
        markets,fills,net,trimmed,hours,days,minimum = metadata['robustness']
        text(64,220,f'Pression + impulsion · entrée à 250 ms · {markets} marchés historiques',24,MUTED)
        for x,label,value in ((64,'NET APRÈS FRAIS ET STRESS',net),(650,'SANS LE MEILLEUR FILL',trimmed)):
            panel((x,320,x+565,475))
            text(x+21,344,label,20,MUTED,True)
            text(x+21,389,number(value*ease)+' USDC',39,MINT if value>=0 else RED,True)
        text(64,530,f'{fills} fills · {hours} blocs horaires · {days}/{minimum} jours pour la fourchette',25,GOLD)
    elif current=='thresholds':
        text(64,title_y,'La marge suffit-elle après les coûts ?',44,FG,True)
        n,rows = metadata['thresholds']
        text(64,221,f'Impulsion Binance · {n} marchés historiques appariés · entrée à 500 ms',24,MUTED)
        panel((64,305,1216,544))
        for x,label in ((90,'MARGE / STRESS'),(438,'FILLS SIMULÉS'),(688,'NET'),(927,'MÊMES FILLS +1¢')):
            text(x,329,label,18,MUTED,True)
        for i,(label,fills,net,extra) in enumerate(rows):
            y = 375+48*i
            text(90,y,label,22,FG,True)
            text(438,y,str(fills),22,FG,True)
            text(688,y,number(net)+' USDC' if fills else '—',22,MINT if fills and net>0 else MUTED,True)
            text(927,y,number(extra)+' USDC' if fills else '—',22,FG if fills else MUTED,True)
        text(64,587,'Le stress peut changer les ordres retenus. La dernière colonne garde les mêmes fills.',21,GOLD)
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
    parser.add_argument('--markout',type=Path)
    parser.add_argument('--pressure',type=Path)
    parser.add_argument('--audit',type=Path)
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
    if args.markout:
        markout = json.loads(args.markout.read_text(encoding='utf8'))
        marks = markout['table']['prior']['250']['impulse']
        meta['exit_marks'] = [(label,marks[key]['mean']) for key,label in
                              [('250','250 ms'),('1000','1 seconde'),('5000','5 secondes'),('15000','15 secondes')]]
        last = marks['15000']
        if last['entries']==1 and last.get('liquidity'):
            statuses = {'entry-edge':'Marge trop basse','entry-depth':'Achat trop mince',
                        'exit-depth':'Vente trop mince','below-minimum':'Sous le minimum'}
            meta['capacity'] = [(size,row['stressedNet'] if row['priced'] else None,
                                 statuses.get(next(iter(row['rejections']),''),'Donnée absente'))
                                for size,row in last['liquidity'].items()]
    if args.pressure:
        report = json.loads(args.pressure.read_text(encoding='utf8'))
        measured = report['sessions']['prior'].get('500')
        if measured:
            labels = {'book':'Carnet seul','depth':'Pression instantanée','persistentDepth':'Pression à deux dates',
                      'impulse':'Impulsion Binance','combined':'Pression + impulsion'}
            meta['pressure'] = (report['comparable']['prior'],report['eligible']['prior'],
                                sum(m['fills'] for m in measured.values()),
                                [(name,measured[key]['brier']) for key,name in labels.items()])
    if args.audit:
        report = json.loads(args.audit.read_text(encoding='utf8'))
        combined = report['analysis'].get('prior',{}).get('250',{}).get('combined')
        if combined and combined['netWithoutBest'] is not None:
            meta['robustness'] = tuple(combined[key] for key in ('markets','fills','net','netWithoutBest','hours','days'))+(report['minBlocks'],)
        grid = report.get('sweep',{}).get('prior',{})
        keys = ('2/0.5','4/0.5','2/1.5')
        if all(grid.get(key,{}).get('500',{}).get('impulse') for key in keys):
            values = [grid[key]['500']['impulse'] for key in keys]
            meta['thresholds'] = (values[0]['markets'],[(key.replace('/', ' ¢ / ').replace('.', ',')+' ¢',
                row['fills'],row['net'],row['netFixedFillsExtraCent']) for key,row in zip(keys,values)])
    duration = 41+8*sum(bool(meta.get(key)) for key in OPTIONAL_SCENES)
    if args.preview:
        render(2,series,meta).save(args.preview)
    command = ['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24',
               '-video_size',f'{W}x{H}','-framerate',str(FPS),'-i','-',
               '-f','lavfi','-i','sine=frequency=110:sample_rate=48000',
               '-af',f'volume=0.14,tremolo=f=3:d=0.65,afade=t=in:st=0:d=2,afade=t=out:st={duration-4}:d=4',
               '-shortest','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',
               '-c:a','aac','-b:a','96k','-movflags','+faststart',str(args.output)]
    with subprocess.Popen(command,stdin=subprocess.PIPE) as encoder:
        with encoder.stdin:
            for f in range(duration*FPS):
                encoder.stdin.write(render(f/FPS,series,meta).tobytes())
        if encoder.wait():
            raise SystemExit('FFmpeg encoding failed')


if __name__ == '__main__':
    main()
