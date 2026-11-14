"""Native Polymarket paper dashboard."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import time
import tkinter as tk
from tkinter import ttk

from desktop import configure_dpi, money

BG, PANEL, BORDER = '#101721', '#172332', '#2b3c50'
FG, MUTED, GREEN, RED, AMBER = '#f1f5fa', '#b1bfd1', '#76e5bf', '#ff9e9f', '#f5c975'
NAMES = {'anchor':'Proxy BTC','momentum':'Momentum','skew':'Quant Skew'}
DEFAULT_PATH = Path(__file__).resolve().parent / 'data/polymarket/status.json'


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
        self.tabs.bind('<<NotebookTabChanged>>',lambda _: self.render_tables())
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
        signal = current.get('state','En attente du worker')
        if fresh and f:
            signal += f"   ·   Momentum {f['momentum']*10000:+.2f} pb   ·   Skew {f['skew']:+.2f}"
        signal += f"   ·   {self.state.get('resolved',0)} / {self.state.get('evaluated',0)} marchés réglés"
        self.signal.configure(text=signal)
        item = self.state.get('summary',{}).get('skew',{})
        pending = item.get('trades',0) - item.get('settled',0)
        net = money(item.get('net'),4) + ' $' if item.get('settled') else '—'
        self.positions.configure(text=f'Quant Skew   ·   P&L réglé  {net}   ·   {pending} position(s) non réglée(s)')
        if fresh and qt != self.quote_time and 'skew' in prob and prob.get('market') is not None:
            self.quote_time = qt
            self.history.append((qt,prob['skew'],prob['market']))
            self.history = self.history[-80:]
            changed = True
        if changed:
            self.draw()
        if changed or (now//1000)%5 == 0:
            self.render_tables()
        self.root.after(1000,self.refresh)

    def draw(self):
        canvas = self.chart
        canvas.delete('all')
        w,h = canvas.winfo_width(),canvas.winfo_height()
        if w < 100 or h < 45:
            return
        for level in (.25,.5,.75):
            y = (h-30)*(1-level)+5
            canvas.create_line(11,y,w-42,y,fill=BORDER,dash=(3,5))
            canvas.create_text(w-6,y,text=f'{level:.0%}',fill=MUTED,anchor='e')
        if not self.history:
            canvas.create_text(w/2,h/2,text='En attente des premières cotations',fill=MUTED)
            return
        start = int(self.market.rsplit('-',1)[-1])*1000
        for index,color in ((1,AMBER),(2,'#91add4')):
            coords = []
            for sample in self.history:
                x = 12+(w-60)*min(1,max(0,(sample[0]-start)/300000))
                y = (h-30)*(1-sample[index])+5
                coords.extend((x,y))
            if len(coords) >= 4:
                canvas.create_line(*coords,fill=color,width=2)
            x,y = coords[-2:]
            canvas.create_oval(x-3,y-3,x+3,y+3,outline='',fill=color)
        canvas.create_text(11,h-11,text='Ouverture',fill=MUTED,anchor='w')
        canvas.create_text(w-42,h-11,text='Échéance',fill=MUTED,anchor='e')

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
        for trial in self.state.get('journal',[]):
            for key,fill in trial['fills'].items():
                winner = trial['winner']
                net = None if winner is None else (10 if winner==fill['side'] else 0)-fill['total']
                tag = 'open' if net is None else 'win' if net>0 else 'loss'
                pending = 'Position ouverte' if int(time.time()*1000) < trial['start']+300000 else 'Règlement en attente'
                trades.append((tag,(timestamp(trial['time']),NAMES.get(key,key),
                    'Up' if fill['side']==0 else 'Down',money(fill['average']*100,1)+' ¢',
                    money(fill['fees'],4),pending if net is None else f'{net:+.4f} $')))
        for tree,rows in ((self.models,model_rows),(self.journal,trades)):
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
