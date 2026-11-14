"""Native Polymarket paper dashboard."""
import argparse
from datetime import date, datetime
import json
from pathlib import Path
import time
from threading import Thread
import tkinter as tk
from tkinter import ttk

from desktop import configure_dpi, money
from euro_reference import REFERENCE, euro_values, format_euro, read_reference

BG, PANEL, BORDER = '#101721', '#172332', '#2b3c50'
FG, MUTED, GREEN, RED, AMBER = '#f1f5fa', '#b1bfd1', '#76e5bf', '#ff9e9f', '#f5c975'
NAMES = {'anchor':'Proxy BTC','momentum':'Momentum','skew':'Quant Skew'}
EDGE_NAMES = {'pair':'Paire Up + Down','opening':'Écart au TWAP d’ouverture',
              'consensus':'Consensus BTC + carnet','skew':'Quant Skew · référence'}
DEFAULT_PATH = Path(__file__).resolve().parent / 'data/polymarket-v2/status.json'


def readable(value):
    try:
        return value.encode('cp1252').decode('utf8')
    except (UnicodeEncodeError,UnicodeDecodeError):
        return value


def timestamp(ms):
    return datetime.fromtimestamp(ms/1000).strftime('%H:%M:%S')


def countdown(end,now):
    seconds = max(0,(end-now+999)//1000)
    return f'{seconds//60:02}:{seconds%60:02}'


class Dashboard:
    def __init__(self, root, path):
        self.root, self.path = root, path
        self.state = {}
        self.modified = None
        self.edge_report = {}
        self.edge_modified = None
        self.flow_report = {}
        self.flow_modified = None
        self.reference = REFERENCE
        self.fx_attempt = None
        self.simple = True
        self.history = []
        self.market = None
        self.quote_time = None
        root.title('VisualTrader · Polymarket BTC')
        root.configure(bg=BG)
        root.geometry(f'{min(1040,root.winfo_screenwidth()-36)}x'
                      f'{min(690,root.winfo_screenheight()-85)}+16+16')
        if float(root.tk.call('tk','scaling')) > 1.55:
            root.tk.call('tk','scaling',1.55)
        root.minsize(740,600)
        style = ttk.Style(root)
        style.theme_use('clam')
        style.configure('.',background=BG,foreground=FG,font=('Segoe UI',10))
        style.configure('Treeview',background=PANEL,fieldbackground=PANEL,foreground=FG,
                        rowheight=26,font=('Consolas',10),borderwidth=0)
        style.configure('Treeview.Heading',background=BORDER,foreground=FG,relief='flat')
        style.map('Treeview',background=[('selected','#345576')])
        style.configure('TNotebook',background=BG,borderwidth=0)
        style.configure('TNotebook.Tab',background=BG,foreground=MUTED,padding=(12,6),borderwidth=0)
        style.map('TNotebook.Tab',background=[('selected',BORDER)],foreground=[('selected',FG)])
        outer = tk.Frame(root,bg=BG,padx=16,pady=12)
        outer.pack(fill='both',expand=True)
        header = tk.Frame(outer,bg=BG)
        outer.columnconfigure(0,weight=1)
        outer.rowconfigure(3,weight=1)
        header.grid(row=0,column=0,sticky='ew')
        self.label(header,'VisualTrader  /  Polymarket',FG,16,True).pack(side='left')
        self.label(header,'PAPER TRADING',AMBER,10,True).pack(side='right')
        self.view_button = ttk.Button(header,text='Vue détaillée',command=self.toggle_view)
        self.view_button.pack(side='right',padx=12)
        market = tk.Frame(outer,bg=BG,pady=8)
        market.grid(row=1,column=0,sticky='ew')
        self.market_label = self.label(market,'BTC Up / Down  ·  5 min',FG,13,True)
        self.market_label.pack(side='left')
        self.health = self.label(market,'Connexion…',MUTED,10)
        self.health.pack(side='right')
        cards = tk.Frame(outer,bg=BG)
        cards.grid(row=2,column=0,sticky='ew',pady=(0,8))
        self.cards = {}
        for i,(key,title) in enumerate([('up','UP · ACHAT / PART'),('down','DOWN · ACHAT / PART'),
                                       ('skew','QUANT SKEW · P(UP)'),('timer','FIN DE FENÊTRE')]):
            cards.columnconfigure(i,weight=1,uniform='card')
            card = tk.Frame(cards,bg=PANEL,highlightthickness=1,highlightbackground=BORDER,padx=9,pady=5)
            card.grid(row=0,column=i,sticky='ew',padx=(0,5 if i<3 else 0))
            self.label(card,title,MUTED,9,bg=PANEL).pack(anchor='w')
            self.cards[key] = self.label(card,'—',{'up':GREEN,'down':RED,'skew':AMBER,'timer':FG}[key],
                                         21,True,bg=PANEL)
            self.cards[key].pack(anchor='w')
        chart_panel = tk.Frame(outer,bg=PANEL,highlightthickness=1,highlightbackground=BORDER)
        chart_panel.grid(row=3,column=0,sticky='nsew')
        self.caption = self.label(chart_panel,'Probabilité Up   ·   Or : Quant Skew   ·   Bleu : carnet',MUTED,10,bg=PANEL)
        self.caption.pack(anchor='w',padx=10,pady=(4,0))
        self.chart = tk.Canvas(chart_panel,bg=PANEL,highlightthickness=0,height=90)
        self.chart.pack(fill='both',expand=True)
        self.chart.bind('<Configure>',lambda _: self.draw())
        self.chart.bind('<Motion>', self.inspect_marker)
        self.chart.bind('<Leave>', lambda _: self.chart.delete('trade-tooltip'))
        self.markers = []
        self.review_trial = None
        self.signal = self.label(outer,'—',MUTED,10)
        self.signal.grid(row=4,column=0,sticky='ew',pady=(4,2))
        self.positions = self.label(outer,'',FG,10,True)
        self.positions.grid(row=5,column=0,sticky='ew',pady=(0,4))
        self.tabs = ttk.Notebook(outer)
        self.tabs.grid(row=6,column=0,sticky='ew')
        self.models = self.table('Modèles',('Modèle','Entrées / réglées','Gagnants','Frais USD','Net réglé USD','Brier'),
                                 (155,105,82,85,98,75),4)
        self.journal = self.table('Trades simulés',('Heure','Modèle','Côté','Prix moy.','Frais USD','État / Net USD'),
                                  (75,130,65,85,90,150),4)
        self.decisions = self.table('Décision',('Modèle','Côté','Prob.','Coût / part','Edge','Motif'),
                                   (126,55,65,86,63,215),4)
        self.lab = self.table('Banc d’essai',('Variante','Fills','Rejets','Inconnus','Frais','Net stressé'),
                              (210,60,65,76,80,110),4)
        self.cohorts = self.table('Cohortes',('Signal · côté · régime · spread','Fills / essais','Inconnus','Net stressé'),
                                  (380,100,76,100),4)
        self.flow = self.table('Flux Binance',('Signal','Marchés','Brier','Fills / essais','Net stressé'),
                               (185,80,80,100,112),4)
        self.journal.bind('<Double-1>',self.review_selected)
        self.live = ttk.Button(header,text='Revenir au direct',command=self.return_live)
        self.tabs.bind('<<NotebookTabChanged>>',lambda _: self.render_tables())
        self.details = (chart_panel,self.signal,self.positions,self.tabs)
        self.overview = tk.Frame(outer,bg=BG)
        self.overview.grid(row=3,column=0,rowspan=4,sticky='nsew')
        hero = tk.Frame(self.overview,bg=PANEL,padx=18,pady=14,
                        highlightthickness=1,highlightbackground=BORDER)
        hero.pack(fill='x')
        self.label(hero,'COMBIEN PAR JOUR ?',MUTED,10,True,bg=PANEL).pack(anchor='w')
        self.projection = self.label(hero,'Données insuffisantes',FG,25,True,bg=PANEL)
        self.projection.pack(anchor='w',pady=(4,3))
        self.projection_detail = self.label(hero,'Attente du rapport de recherche',MUTED,10,bg=PANEL)
        self.projection_detail.pack(anchor='w')
        horizons = tk.Frame(hero,bg=PANEL)
        horizons.pack(fill='x',pady=(8,0))
        self.hour = self.label(horizons,'— / heure',FG,13,True,bg=PANEL)
        self.hour.pack(side='left')
        self.month = self.label(horizons,'— / 30 jours',FG,13,True,bg=PANEL)
        self.month.pack(side='left',padx=24)
        tiles = tk.Frame(self.overview,bg=BG)
        tiles.pack(fill='x',pady=10)
        self.overview_values = {}
        for i,(key,label) in enumerate((('net','NET QUANT SKEW'),('fills','FILLS RÉGLÉS'),('coverage','MARCHÉS PROSPECTIFS'))):
            tiles.columnconfigure(i,weight=1,uniform='overview')
            box = tk.Frame(tiles,bg=PANEL,padx=12,pady=9,highlightthickness=1,highlightbackground=BORDER)
            box.grid(row=0,column=i,sticky='ew',padx=(0,6 if i<2 else 0))
            self.label(box,label,MUTED,9,True,bg=PANEL).pack(anchor='w')
            self.overview_values[key] = self.label(box,'—',FG,17,True,bg=PANEL)
            self.overview_values[key].pack(anchor='w',pady=(3,0))
        insights = tk.Frame(self.overview,bg=PANEL,padx=18,pady=11,
                            highlightthickness=1,highlightbackground=BORDER)
        insights.pack(fill='both',expand=True)
        self.label(insights,'Lecture automatique',FG,12,True,bg=PANEL).pack(anchor='w')
        self.insights = tk.Label(insights,bg=PANEL,fg=MUTED,font=('Segoe UI',10),anchor='nw',justify='left')
        self.insights.pack(fill='both',expand=True,pady=(6,0))
        insights.bind('<Configure>',lambda event: self.insights.configure(wraplength=max(360,event.width-40)))
        for widget in self.details:
            widget.grid_remove()
        self.refresh()

    def label(self,parent,text,color,size,bold=False,bg=BG):
        return tk.Label(parent,text=text,bg=bg,fg=color,font=('Segoe UI',size,'bold' if bold else 'normal'),
                        anchor='w',padx=0)

    def table(self,title,columns,widths,height):
        pane = tk.Frame(self.tabs,bg=BG)
        self.tabs.add(pane,text=title)
        tree = ttk.Treeview(pane,columns=columns,show='headings',height=height)
        for i,(name,width) in enumerate(zip(columns,widths)):
            tree.heading(name,text=name,anchor='w' if i==0 else 'e')
            tree.column(name,width=width,minwidth=60,anchor='w' if i==0 else 'e')
        scroll = ttk.Scrollbar(pane,orient='vertical',command=tree.yview)
        scroll.pack(side='right',fill='y')
        tree.configure(yscrollcommand=scroll.set)
        tree.pack(fill='both',expand=True)
        tree.tag_configure('win',foreground=GREEN)
        tree.tag_configure('loss',foreground=RED)
        tree.tag_configure('open',foreground=AMBER)
        return tree

    def toggle_view(self):
        self.simple = not self.simple
        if self.simple:
            self.live.pack_forget()
            for widget in self.details:
                widget.grid_remove()
            self.overview.grid()
        else:
            self.overview.grid_remove()
            for widget in self.details:
                widget.grid()
            if self.review_trial:
                self.live.pack(side='right',padx=10)
            self.draw()
            self.render_tables()
        self.view_button.configure(text='Vue détaillée' if self.simple else 'Vue simplifiée')

    def update_reference(self):
        try:
            reference = read_reference()
            if reference[0]>=self.reference[0]:
                self.reference = reference
        except (ValueError,OSError):
            pass

    def refresh_overview(self, now):
        if self.fx_attempt is None or now-self.fx_attempt>6*3600_000:
            self.fx_attempt=now
            Thread(target=self.update_reference,daemon=True).start()
        fx_date,fx_rate = self.reference
        fx = fx_rate if 0 <= (date.today()-fx_date).days <= 7 else None
        source = self.path.with_name('edge.json')
        try:
            stamp = source.stat().st_mtime_ns
            if stamp != self.edge_modified:
                self.edge_report = json.loads(source.read_text(encoding='utf8'))
                self.edge_modified = stamp
        except (OSError, ValueError):
            pass
        source = self.path.with_name('spot-benchmark.json')
        try:
            stamp = source.stat().st_mtime_ns
            if stamp != self.flow_modified:
                self.flow_report = json.loads(source.read_text(encoding='utf-8-sig'))
                self.flow_modified = stamp
        except (OSError, ValueError):
            pass
        report = self.edge_report
        fresh = self.edge_modified and now-self.edge_modified//1_000_000<180000
        model = self.state.get('summary',{}).get('skew',{})
        fills = model.get('settled',0)
        net = model.get('net',0)
        models = report.get('table',{}).get('500',{})
        qualified = report.get('qualified',[]) if fresh else []
        model_key = qualified[0] if qualified else 'consensus'
        estimate = models.get(model_key,{}).get('daily') if fresh and report.get('prospective') else None
        if estimate and fx:
            low,high = estimate['range']
            hour,day,month = euro_values(estimate['mean'],fx)
            self.projection.configure(text=format_euro(day)+' / jour',fg=FG)
            self.projection_detail.configure(text=f"{EDGE_NAMES[model_key]} · {format_euro(low/fx)} à {format_euro(high/fx)} / jour · {estimate['days']} jours")
            self.hour.configure(text=format_euro(hour)+' / heure')
            self.month.configure(text=format_euro(month)+' / 30 jours')
        else:
            policy = report.get('policy',{})
            detail = ('Rapport de recherche indisponible' if not fresh else
                      f"Consensus · {models.get('consensus',{}).get('tradingDays',0)}/{policy.get('minTradingDays',10)} jours avec fills · replay à 500 ms")
            self.projection.configure(text='Estimation indisponible' if not estimate else 'Conversion indisponible',fg=FG)
            self.projection_detail.configure(text=detail if not estimate else 'Taux BCE récent indisponible')
            self.hour.configure(text='— / heure')
            self.month.configure(text='— / 30 jours')
        self.overview_values['net'].configure(text=(format_euro(net/fx) if fx else f'{net:+.2f} USDC') if fills else '—',
                                             fg=GREEN if net>0 else RED if net<0 else FG)
        self.overview_values['fills'].configure(text=f"{fills} / {model.get('trades',0)}")
        expected = report.get('expected',0)
        self.overview_values['coverage'].configure(text=f"{report.get('settled',0)} / {expected}" if fresh else '—')
        status = ('Candidats paper qualifiés · '+', '.join(EDGE_NAMES[k] for k in qualified) if qualified else
                  'Replay rétrospectif. Qualification désactivée.' if fresh and report.get('verdict')=='retrospective' else
                  'Aucun candidat qualifié à la clôture du test.' if fresh and report.get('verdict')=='no-candidate' else
                  'Validation prospective en cours.' if fresh else 'Attente du rapport de recherche.')
        benchmark = self.state.get('summary',{}).get('market',{}).get('brier')
        brier = model.get('brier')
        forecast = (f"Brier Skew {brier:.3f} · carnet {benchmark:.3f} (plus bas = mieux)."
                    if benchmark is not None and brier is not None else '')
        gaps = report.get('diagnostics',{})
        quality = (f"Couverture · {gaps.get('missingTrials',0)} signaux manquants · "
                   f"{gaps.get('missingBooks',0)} carnets manquants · {gaps.get('waitingSettlement',0)} règlements en attente.") if fresh else ''
        conversion = f"Conversion indicative · BCE {fx_date:%d/%m/%Y} · 1 USDC ≈ 1 USD." if fx else ''
        grouped = self.flow_report.get('benchmark',{})
        flow = grouped.get('prior',{}).get('250',{}).get('impulse',{})
        flow_line = (f"Flux Binance · {flow['fills']} fill(s) historique(s) à 250 ms sur {flow['markets']} marchés comparables."
                     if flow and self.flow_modified and now-self.flow_modified//1_000_000<600000 else '')
        self.insights.configure(text='\n'.join(s for s in (status,forecast,quality,flow_line,conversion) if s))

    def refresh(self):
        changed = False
        try:
            stamp = self.path.stat().st_mtime_ns
            if stamp != self.modified:
                self.state = json.loads(self.path.read_text(encoding='utf8'))
                self.modified = stamp
                changed = True
        except (OSError,ValueError):
            pass
        current = self.state.get('current') or {}
        now = int(time.time()*1000)
        slug = current.get('slug')
        if slug != self.market:
            self.market = slug
            self.history.clear()
            self.quote_time = None
            changed = True
        if slug:
            start = int(slug.rsplit('-',1)[-1])*1000
            end = start+300000
            self.market_label.configure(text=f'BTC Up / Down   ·   {timestamp(start)[:5]}–{timestamp(end)[:5]}')
            self.cards['timer'].configure(text=countdown(end,now))
        else:
            end = 0
        qt = current.get('quoteTime')
        fresh = bool(qt and 0 <= now-qt < 15000 and now < end and not self.state.get('lastError'))
        active = bool(self.modified and now-self.modified//1_000_000 < 15000)
        quotes = current.get('quotes') or []
        complete = fresh and len(quotes) == 2 and all(quotes)
        self.health.configure(text='●  CARNET ACTUALISÉ' if complete else
                              '◌  CARNET PARTIEL' if fresh and any(quotes) else
                              '◌  EN ATTENTE DE COTATIONS' if active else '○  FLUX INACTIF',
                              fg=GREEN if fresh else AMBER)
        for i,key in enumerate(('up','down')):
            self.cards[key].configure(text=money(quotes[i]['total']*10,1)+' ¢'
                                      if fresh and len(quotes)>i and quotes[i] else '—')
        prob = current.get('prob') or {}
        self.cards['skew'].configure(text=money(prob['skew']*100,1)+' %' if fresh and 'skew' in prob else '—')
        f = current.get('features') or {}
        signal = readable(current.get('state','En attente du worker'))
        if fresh and f:
            signal += f"   ·   Momentum {f['momentum']*10000:+.2f} pb   ·   Skew {f['skew']:+.2f}"
        signal += f"   ·   {self.state.get('resolved',0)} / {self.state.get('evaluated',0)} marchés réglés"
        self.signal.configure(text=signal)
        item = self.state.get('summary',{}).get('skew',{})
        pending = item.get('trades',0) - item.get('settled',0)
        net = money(item.get('net'),4) + ' $' if item.get('settled') else '—'
        paired = self.state.get('paired',{})
        missed = self.state.get('coverage',{}).get('missed',0)
        feed_status = self.path.parent.parent / 'polymarket-clob' / 'status.json'
        try:
            feed = json.loads(feed_status.read_text(encoding='utf8'))
            if feed['slug'] == slug and feed['fresh'] and now - feed['checked'] < 5000:
                self.health.configure(text='●  CLOB ENREGISTRÉ',fg=GREEN)
        except (OSError,ValueError,KeyError):
            pass
        self.positions.configure(text=f"Skew net {net}   ·   Ouvert {pending} / {money(item.get('openCost'),2)} $"
                                 f"   ·   Δ vs Momentum {money(paired.get('skewNet'),2)} $   ·   Ratés {missed}")
        if 'history' in self.state:
            self.history = [(r['time'],r['skew'],r['market']) for r in self.state['history']
                            if r['market'] is not None]
        elif fresh and qt != self.quote_time and 'skew' in prob and prob.get('market') is not None:
            self.quote_time = qt
            self.history.append((qt,prob['skew'],prob['market']))
            self.history = self.history[-80:]
            changed = True
        self.refresh_overview(now)
        if not self.simple:
            if changed:
                self.draw()
            if changed or (now//1000)%5 == 0:
                self.render_tables()
        self.root.after(1000,self.refresh)

    def draw(self):
        canvas = self.chart
        canvas.delete('all')
        self.markers.clear()
        w,h = canvas.winfo_width(),canvas.winfo_height()
        if w < 100 or h < 45:
            return
        for level in (.25,.5,.75):
            y = (h-30)*(1-level)+5
            canvas.create_line(11,y,w-42,y,fill=BORDER,dash=(3,5))
            canvas.create_text(w-6,y,text=f'{level:.0%}',fill=MUTED,anchor='e')
        if not self.market:
            return
        trial = self.review_trial or next((r for r in self.state.get('journal',[])
                                          if r['slug']==self.market),None)
        history = self.history
        if self.review_trial:
            history = self.review_trial.get('history',[])
        start = int((trial['slug'] if self.review_trial else self.market).rsplit('-',1)[-1])*1000
        if not history and not trial:
            canvas.create_text(w/2,h/2,text='En attente des premières cotations',fill=MUTED)
        for index,color in ((1,AMBER),(2,'#91add4')):
            coords = []
            for sample in history:
                x = 12+(w-60)*min(1,max(0,(sample[0]-start)/300000))
                y = (h-30)*(1-sample[index])+5
                coords.extend((x,y))
            if len(coords) >= 4:
                canvas.create_line(*coords,fill=color,width=2)
            if coords:
                x,y = coords[-2:]
                canvas.create_oval(x-3,y-3,x+3,y+3,outline='',fill=color)
        canvas.create_text(11,h-11,text='Ouverture',fill=MUTED,anchor='w')
        canvas.create_text(w-42,h-11,text='Échéance',fill=MUTED,anchor='e')
        if trial:
            for offset,(name,label) in enumerate(NAMES.items()):
                fill = (trial.get('fills') or {}).get(name)
                reason = (trial.get('reasons') or {}).get(name)
                if not fill and not reason:
                    continue
                t = fill.get('time',trial['time']) if fill else trial['time']
                x = 12+(w-60)*min(1,max(0,(t-start)/300000))
                y = 16 + offset*20
                color = (GREEN if fill['side']==0 else RED) if fill else MUTED
                if fill:
                    canvas.create_polygon(x,y-5,x+5,y,x,y+5,x-5,y,fill=color,outline=FG)
                else:
                    canvas.create_oval(x-4,y-4,x+4,y+4,outline=color,width=2)
                canvas.create_text(x+10,y,text=label,fill=color,anchor='w',font=('Segoe UI',8,'bold'))
                side = fill['side'] if fill else reason.get('side')
                lines = [f"{label}  ·  {timestamp(t)}",
                         ('Up' if side==0 else 'Down' if side==1 else '—') + ' · ' + (readable(reason['reason']) if reason else 'Fill simulé')]
                if reason and reason.get('prob') is not None:
                    lines.append(f"Prob. {reason['prob']:.1%} · edge signal {reason['signalEdge']*100:+.1f} ¢")
                if fill:
                    lines.append(f"Coût {fill['total']:.4f} $ · frais {fill['fees']:.4f} $")
                    if trial['winner'] is not None:
                        paid = 10 if trial['winner']==side else 0
                        lines.append(f"P&L réglé {paid-fill['total']:+.4f} $")
                self.markers.append((x,y,'\n'.join(lines)))

    def inspect_marker(self,event):
        canvas = self.chart
        canvas.delete('trade-tooltip')
        if not self.markers:
            return
        x,y,detail = min(self.markers,key=lambda r:(event.x-r[0])**2+(event.y-r[1])**2)
        if abs(event.y-y)>9 or not x-9<=event.x<=x+96:
            return
        w,h = canvas.winfo_width(),canvas.winfo_height()
        item = canvas.create_text(0,0,text=detail,anchor='nw',fill=FG,
                                  font=('Segoe UI',9),tags='trade-tooltip')
        _,_,right,bottom = canvas.bbox(item)
        tx,ty = max(9,min(event.x+14,w-right-10)),max(9,min(event.y+14,h-bottom-10))
        canvas.coords(item,tx,ty)
        left,top,right,bottom = canvas.bbox(item)
        shade = canvas.create_rectangle(left-6,top-4,right+6,bottom+4,fill=BG,
                                        outline=BORDER,tags='trade-tooltip')
        canvas.tag_lower(shade,item)

    def review_selected(self, event):
        item = self.journal.identify_row(event.y)
        if not item:
            return
        index = self.journal.index(item)
        if index >= len(self.trade_trials):
            return
        import sqlite3
        trial = self.trade_trials[index].copy()
        db_path = self.path.with_name('paper.sqlite')
        try:
            db = sqlite3.connect(db_path.resolve().as_uri()+'?mode=ro',uri=True,timeout=.2)
            try:
                trial['history'] = list(db.execute(
                    'SELECT time,skew,market FROM chart WHERE start=? AND market IS NOT NULL ORDER BY time',
                    (trial['start'],)))
            finally:
                db.close()
        except sqlite3.Error:
            trial['history'] = []
        self.review_trial = trial
        self.live.pack(side='right',padx=10)
        self.caption.configure(text=f"Replay · {timestamp(trial['start'])} · Or : Skew · Bleu : carnet")
        self.draw()

    def return_live(self):
        self.review_trial = None
        self.live.pack_forget()
        self.caption.configure(text='Probabilité Up   ·   Or : Quant Skew   ·   Bleu : carnet')
        self.draw()


    def render_tables(self):
        model_rows = []
        for key,label in [*NAMES.items(),('market','Carnet · référence')]:
            item = self.state.get('summary',{}).get(key)
            if item:
                net = item['net']
                model_rows.append(('win' if net>0 else 'loss' if net<0 else '',
                    (label,f"{item['trades']} / {item['settled']}",item['wins'],money(item['fees'],4),
                     money(net,4) if item['settled'] else '—',money(item['brier'],4))))
        trades = []
        self.trade_trials = []
        for trial in self.state.get('journal',[]):
            for key,fill in trial['fills'].items():
                self.trade_trials.append(trial)
                winner = trial['winner']
                net = None if winner is None else (10 if winner==fill['side'] else 0)-fill['total']
                tag = 'open' if net is None else 'win' if net>0 else 'loss'
                pending = 'Position ouverte' if int(time.time()*1000) < trial['start']+300000 else 'Règlement en attente'
                trades.append((tag,(timestamp(trial['time']),NAMES.get(key,key),
                    'Up' if fill['side']==0 else 'Down',money(fill['average']*100,1)+' ¢',
                    money(fill['fees'],4),pending if net is None else f'{net:+.4f} $')))
        decisions = []
        for trial in self.state.get('journal',[])[:1]:
            for key,result in (trial.get('reasons') or {}).items():
                side = result.get('side')
                pct = lambda v: money(v*100,1) if v is not None else '—'
                decisions.append(('',(NAMES[key],'Up' if side==0 else 'Down' if side==1 else '—',
                     pct(result.get('prob')),pct(result.get('cost')),pct(result.get('signalEdge')),readable(result['reason']))))
        for gap in self.state.get('misses',[])[:4]:
            decisions.append(('open',(timestamp(gap['start']),'—','—','—','—',readable(gap['detail']))))
        lab = []
        for key,item in self.edge_report.get('table',{}).get('500',{}).items():
            lab.append(('',(EDGE_NAMES.get(key,key),item['fills'],item['rejected'],item['unknown'],
                            money(item['fees'],2),money(item['stress'],2) if item['fills'] else '—')))
        regimes = {'up':'Up','down':'Down','pair':'Paire','high-vol':'vol. haute','low-vol':'vol. basse',
                   'aligned':'aligné','divergent':'divergent','wide':'large','tight':'serré','missing-spread':'inconnu'}
        cohorts = []
        for key,item in sorted(self.edge_report.get('crosses',{}).items()):
            variant,*factors = key.split('/')
            label = ' · '.join([EDGE_NAMES.get(variant,variant),*(regimes.get(f,f) for f in factors)])
            cohorts.append(('',(label,f"{item['fills']} / {item['attempts']}",item['unknown'],
                                money(item['stress'],2) if item['fills'] else '—')))
        flows = []
        grouped = self.flow_report.get('benchmark',{})
        names = {'book':'Carnet seul','flow':'Déséquilibre 30 s','impulse':'Impulsion 10/30 s','combined':'Combinaison'}
        for phase,label in [('forward','Prospectif'),('prior','Historique')]:
            for delay in (250,500,1000):
                models = grouped.get(phase,{}).get(str(delay),{})
                if models:
                    flows.append(('open',(f'{label} · {delay} ms','','','','')))
                for model,item in models.items():
                    flows.append(('',(names[model],item['markets'],money(item['brier'],3),
                                      f"{item['fills']} / {item['attempts']}",
                                      money(item['stressNet'],2) if item['fills'] else '—')))
        for tree,rows in ((self.models,model_rows),(self.journal,trades),(self.decisions,decisions),
                          (self.lab,lab),(self.cohorts,cohorts),(self.flow,flows)):
            ids = tree.get_children()
            for i,(tag,row) in enumerate(rows):
                if i < len(ids):
                    tree.item(ids[i],values=row,tags=(tag,))
                else:
                    tree.insert('','end',values=row,tags=(tag,))
            if len(ids)>len(rows):
                tree.delete(*ids[len(rows):])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--status',type=Path,default=DEFAULT_PATH)
    args = parser.parse_args()
    configure_dpi()
    root = tk.Tk()
    Dashboard(root,args.status)
    root.mainloop()


if __name__ == '__main__':
    main()
