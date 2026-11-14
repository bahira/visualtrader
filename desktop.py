"""VisualTrader's native desktop client. Requires Python 3.10+ and Tk."""
import argparse
import sys
from bisect import bisect_left
from datetime import datetime
import json
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, font, messagebox, ttk
from concurrent.futures import ThreadPoolExecutor
from urllib.request import build_opener, ProxyHandler, Request

BG, PANEL, GRID = '#101721', '#151f2c', '#29374a'
FG, MUTED, UP, DOWN, GOLD = '#f0f4fa', '#acbbcf', '#74e4bd', '#ff9c9a', '#f5c975'
RANGES = {'1 s': {'30 s': 30, '1 min': 60, '2 min': 120},
          'Time': {'1 h': 60, '4 h': 240, '16 h': 960},
          'Capital': {'1 min': 60, '3 min': 180, '5 min': 300}}


def money(value, digits=2):
    if value is None:
        return '—'
    return f'{value:,.{digits}f}'.replace(',', ' ').replace('.', ',')


def clock(value):
    return datetime.fromtimestamp(value / 1000).strftime('%H:%M:%S') if value else '—'


class Client:
    def __init__(self, port):
        self.url = f'http://127.0.0.1:{port}'
        self.opener = build_opener(ProxyHandler({}))

    def request(self, path, action=False, raw=False):
        headers = {'Origin': self.url} if action else {}
        req = Request(self.url + path, headers=headers, method='POST' if action else 'GET')
        with self.opener.open(req, timeout=2) as response:
            return response.read() if raw else json.load(response)

    def snapshot(self, want_history, history_version):
        state = self.request('/api/client')
        version = state['historyVersion']
        history = None
        if want_history and version is not None and version != history_version:
            history = self.request('/api/time')
        return state, history


def timeline(candles, history):
    minutes = {item['t']: item.copy() for item in history}
    cutoff = history[-1]['t'] if history else -1
    for candle in candles:
        minute = candle['t'] // 60000 * 60000
        if minute <= cutoff:
            continue
        volume = minutes.get(minute, {}).get('v', 0)
        minutes[minute] = {'t': minute, 'c': candle['c'], 'v': volume + candle['v']}
    return sorted(minutes.values(), key=lambda item: item['t'])


class Desktop:
    def __init__(self, root, client, smoke=False):
        self.root, self.client, self.smoke = root, client, smoke
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='visualtrader')
        self.future = None
        self.action = None
        self.version = None
        self.history = []
        self.state = None
        archive = Path(__file__).resolve().parent / 'data' / 'phoenix-archive.json'
        try:
            self.phoenix_backtest = json.loads(archive.read_text(encoding='utf8'))
        except (OSError, ValueError):
            self.phoenix_backtest = None
        try:
            self.phoenix_research = json.loads(archive.with_name('phoenix-research.json').read_text(encoding='utf8'))
        except (OSError, ValueError):
            self.phoenix_research = None
        self.connected = False
        self.view = '1 s'
        self.chart_key = None
        self.table_key = None
        self.result = 1
        root.configure(bg=BG)
        root.title('VisualTrader | BTC/USDT')
        screen_width, screen_height = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f'{min(1328, screen_width - 32)}x{min(840, screen_height - 85)}+12+12')
        root.minsize(780, 560)
        root.protocol('WM_DELETE_WINDOW', self.close)
        # Keep point-sized controls usable on compact high-DPI Windows displays.
        if float(root.tk.call('tk', 'scaling')) > 1.55:
            root.tk.call('tk', 'scaling', 1.55)
        self.style()
        self.axis = font.Font(root=root, family='Consolas', size=8)
        frame = ttk.Frame(root, padding=(14, 8, 14, 6))
        frame.pack(fill='both', expand=True)

        header = ttk.Frame(frame)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(2, weight=1)
        header.grid(row=0, column=0, sticky='ew', pady=(0, 10))
        ttk.Label(header, text='◈  VISUALTRADER', style='Brand.TLabel').pack(side='left')
        ttk.Label(header, text='PAPER TRADING', style='Paper.TLabel', padding=(10, 5)).pack(side='right')
        self.label = ttk.Label(header, style='Muted.TLabel', padding=(0, 0, 14, 0))
        self.label.pack(side='right')

        overview = ttk.Frame(frame)
        overview.grid(row=1, column=0, sticky='ew', pady=(0, 8))
        quote = ttk.Frame(overview)
        overview.columnconfigure(1, weight=1)
        quote.grid(row=0, column=0, sticky='w', padx=(0, 16))
        ttk.Label(quote, text='BTC/USDT · BINANCE SPOT', style='Muted.TLabel').pack(anchor='w')
        self.price = ttk.Label(quote, text='—', style='Title.TLabel')
        self.price.pack(anchor='w')
        self.metrics = {}
        metrics = ttk.Frame(overview)
        metrics.grid(row=0, column=1, sticky='ew')
        for i, (key, title) in enumerate([('equity', 'CAPITAL LIQ.'), ('net', 'P&L NET'),
                                         ('fees', 'FRAIS'), ('drawdown', 'DRAWDOWN MAX.')]):
            metrics.columnconfigure(i, weight=1, uniform='metric')
            tile = ttk.Frame(metrics, style='Panel.TFrame', padding=(8, 6))
            tile.grid(row=0, column=i, sticky='nsew', padx=(5, 0))
            ttk.Label(tile, text=title, style='Muted.Panel.TLabel').pack(anchor='w')
            value = ttk.Label(tile, text='—', style='Value.Panel.TLabel')
            value.pack(anchor='w', pady=(3, 0))
            self.metrics[key] = value

        def reflow(event):
            compact = event.width < 970
            metrics.grid_configure(row=int(compact), column=int(not compact),
                                   columnspan=2 if compact else 1, pady=(4, 0) if compact else 0)
        overview.bind('<Configure>', reflow)

        workspace = ttk.Frame(frame)
        workspace.grid(row=2, column=0, sticky='nsew', pady=(0, 8))
        plot = ttk.Frame(workspace, style='Panel.TFrame', padding=(10, 7, 10, 4))
        plot.pack(side='left', fill='both', expand=True)
        controls = ttk.Frame(plot, style='Panel.TFrame')
        controls.pack(fill='x')
        self.view_var = tk.StringVar(value=self.view)
        for i, view in enumerate(('1 s', 'Time', 'Capital'), 1):
            ttk.Radiobutton(controls, text=view, value=view, variable=self.view_var,
                            style='Segment.TRadiobutton', command=self.select_view).pack(side='left', padx=(0, 4))
            root.bind(f'<Control-Key-{i}>', lambda event, value=view: self.switch_view(value))
        self.range_var = tk.StringVar()
        self.range = ttk.Combobox(controls, state='readonly', textvariable=self.range_var, width=8)
        self.range.pack(side='right')
        self.range.bind('<<ComboboxSelected>>', lambda event: self.redraw())
        self.set_ranges()
        self.chart = tk.Canvas(plot, background=PANEL, highlightthickness=0, height=165)
        self.chart.pack(fill='both', expand=True, pady=(5, 0))
        self.chart.bind('<Configure>', self.resize)
        self.chart.bind('<Motion>', self.inspect)
        self.chart.bind('<Leave>', self.clear_cursor)
        self.chart.bind('<MouseWheel>', self.zoom)
        self.points = []
        self.cursor = []
        self.hover = None
        self.chart_bounds = ()
        self.detail = ttk.Label(plot, text='En attente du marché', style='Muted.Panel.TLabel')
        self.detail.pack(fill='x', pady=(3, 0))

        side = ttk.Frame(workspace, width=225, style='Panel.TFrame', padding=(8, 5))
        side.pack(side='right', fill='y', padx=(9, 0), before=plot)
        side.pack_propagate(False)
        ttk.Label(side, text='Carnet d’ordres', style='Section.Panel.TLabel').pack(anchor='w')
        self.depth = tk.Canvas(side, bg=PANEL, highlightthickness=0, height=121)
        self.depth.pack(fill='x', pady=(3, 2))
        self.depth_key = None
        self.depth.bind('<Configure>', lambda event: self.draw_depth(force=True))
        self.book_note = ttk.Label(side, text='Spread —', style='Muted.Panel.TLabel')
        self.book_note.pack(anchor='w')
        ttk.Separator(side).pack(fill='x', pady=4)
        ttk.Label(side, text='Stratégie active', style='Muted.Panel.TLabel').pack(anchor='w')
        self.strategy = ttk.Label(side, text='Cash', style='Section.Panel.TLabel')
        self.strategy.pack(anchor='w', pady=(0, 3))
        self.decision = ttk.Label(side, text='En attente du moteur', style='Muted.Panel.TLabel', wraplength=195)
        self.decision.pack(anchor='w')

        self.tabs = ttk.Notebook(frame)
        self.tabs.grid(row=3, column=0, sticky='ew')
        self.tables = {}
        self.table('Transactions', [('Heure', 122), ('Côté', 105), ('Prix USDT', 140), ('Quantité BTC', 128)])
        self.table('Exécutions', [('Heure', 85), ('Côté', 60), ('Prix USDT', 105), ('BTC', 105),
                                  ('Frais', 75), ('Latence', 77), ('Net cycle', 82), ('Motif', 165)])
        self.table('Optimiseur', [('Stratégie', 120), ('Score pb', 100), ('Net réalisé', 110),
                                  ('Cycles', 70), ('Drawdown', 105)])
        self.table('Statistiques', [('Indicateur', 235), ('Valeur', 270)])
        self.table('Décisions', [('Heure', 95), ('Couverture', 100), ('Motif', 465)])
        self.table('Cadence', [('Indicateur', 235), ('Valeur', 265)])
        self.table('Fills rapides', [('Heure', 85), ('Côté', 60), ('Prix USDT', 105), ('BTC', 95),
                                    ('Frais', 75), ('Latence', 77), ('Net cycle', 82), ('Motif', 170)])
        self.table('Phoenix', [('Indicateur', 235), ('Cadence', 180), ('Filtre Phoenix', 200)])
        self.table('Archive 4 h', [('Indicateur', 240), ('Freqtrade · futures', 400)])
        self.table('Étude 4 h', [('Variante', 175), ('2025–26 net', 113), ('Stress net', 100),
                                 ('Drawdown', 112), ('Cycles', 80)])
        self.table('Poly BTC', [('Modèle', 185), ('Tr. / réglés', 110), ('Gains', 70),
                                ('Frais USD', 85), ('Net USD', 85), ('Brier', 75)])
        self.tabs.bind('<<NotebookTabChanged>>', self.tab_changed)
        bottom = ttk.Frame(frame)
        bottom.grid(row=4, column=0, sticky='ew', pady=(6, 0))
        self.runtime = ttk.Label(bottom, style='Muted.TLabel')
        self.pause = ttk.Button(bottom, text='Pause entrées', command=self.toggle_pause, state='disabled')
        self.pause.pack(side='right')
        ttk.Button(bottom, text='Exporter le journal', command=self.export).pack(side='right', padx=(0, 6))
        self.runtime.pack(side='left', fill='x', expand=True)
        self.poll()
        if smoke:
            root.after(12000, self.close)

    def style(self):
        style = ttk.Style(self.root)
        style.theme_use('clam')
        style.configure('.', background=BG, foreground=FG, font=('Segoe UI', 10))
        style.configure('Panel.TFrame', background=PANEL, borderwidth=1, relief='solid', bordercolor=GRID)
        style.configure('Title.TLabel', foreground=FG, font=('Segoe UI Semibold', 25))
        style.configure('Brand.TLabel', foreground=GOLD, font=('Segoe UI Semibold', 12))
        style.configure('Paper.TLabel', background='#352b1c', foreground=GOLD, font=('Consolas', 10, 'bold'))
        style.configure('Muted.TLabel', foreground=MUTED, font=('Segoe UI', 9))
        style.configure('Muted.Panel.TLabel', background=PANEL, foreground=MUTED, font=('Segoe UI', 9))
        style.configure('Section.Panel.TLabel', background=PANEL, foreground=FG, font=('Segoe UI Semibold', 12))
        style.configure('Value.Panel.TLabel', background=PANEL, foreground=FG, font=('Consolas', 12, 'bold'))
        style.configure('Treeview', background=PANEL, fieldbackground=PANEL, foreground=FG,
                        rowheight=23, borderwidth=0, font=('Consolas', 10))
        style.configure('Treeview.Heading', background='#202b39', foreground=MUTED, relief='flat')
        style.configure('TButton', background='#263446', bordercolor=GRID, padding=(9, 4))
        style.configure('TNotebook', borderwidth=0, tabmargins=(0, 0, 0, 0))
        style.configure('TNotebook.Tab', background=BG, foreground=MUTED, padding=(13, 6))
        style.configure('Segment.TRadiobutton', background=PANEL, foreground=MUTED,
                        indicatormargin=0, padding=(9, 5))
        style.layout('Segment.TRadiobutton', [
            ('Radiobutton.padding', {'children': [
                ('Radiobutton.focus', {'children': [('Radiobutton.label', {})]})
            ]})
        ])
        style.map('Segment.TRadiobutton', background=[('selected', '#314059'), ('active', GRID)],
                  foreground=[('selected', FG)], focuscolor=[('focus', GOLD)])
        style.map('Treeview', background=[('selected', '#2b4661')], foreground=[('selected', FG)])
        style.map('TButton', background=[('active', '#344a63')], bordercolor=[('focus', GOLD)])
        style.map('TNotebook.Tab', background=[('selected', '#26364b')], foreground=[('selected', FG)])
        style.map('TCombobox', fieldbackground=[('readonly', '#263446')], foreground=[('readonly', FG)])


    def table(self, name, columns):
        pane = ttk.Frame(self.tabs)
        grid = ttk.Treeview(pane, columns=list(range(len(columns))), show='headings', height=3)
        for i, (label, width) in enumerate(columns):
            anchor = 'w' if i == 0 or label in {'Côté', 'Motif', 'Valeur'} else 'e'
            grid.heading(i, text=label, anchor=anchor)
            grid.column(i, width=width, minwidth=45, stretch=True, anchor=anchor)
        scrollbar = ttk.Scrollbar(pane, orient='vertical', command=grid.yview)
        grid.configure(yscrollcommand=scrollbar.set)
        grid.tag_configure('up', foreground=UP)
        grid.tag_configure('down', foreground=DOWN)
        grid.tag_configure('stripe', background='#192534')
        grid.pack(side='left', fill='both', expand=True)
        scrollbar.pack(side='right', fill='y')
        self.tables[name] = grid
        self.tabs.add(pane, text=name)

    def resize(self, _event):
        self.chart_key = None
        self.redraw()

    def switch_view(self, view):
        self.view_var.set(view)
        self.select_view()

    def set_ranges(self):
        choices = list(RANGES[self.view])
        self.range.configure(values=choices)
        self.range_var.set(choices[-1])

    def select_view(self):
        self.view = self.view_var.get()
        self.hover = None
        self.set_ranges()
        self.redraw()

    def zoom(self, event):
        options = list(RANGES[self.view])
        index = options.index(self.range_var.get()) + (-1 if event.delta > 0 else 1)
        self.range_var.set(options[max(0, min(len(options) - 1, index))])
        self.redraw()

    def tab_changed(self, _event):
        self.update_table()

    def poll(self):
        if self.action is not None and self.action.done():
            try:
                self.action.result()
            except (OSError, ValueError) as error:
                messagebox.showerror('VisualTrader', str(error), parent=self.root)
            self.action = None
        if self.future is not None:
            if not self.future.done():
                self.root.after(60, self.poll)
                return
            try:
                state, history = self.future.result()
                if history is not None:
                    self.history = history
                    self.version = history[-1]['t'] if history else None
                self.state = state
                self.connected = True
                self.render()
                if self.smoke and state['marketReady'] and state['chart']:
                    if self.view == 'Time' and (self.history or state['mode'] != 'live'):
                        assert self.points and self.depth.find_all()
                        self.switch_view('Capital')
                        assert self.points
                        self.switch_view('1 s')
                        assert self.points
                        self.inspect_point(self.points[-1][0])
                        assert self.cursor and 'O ' in self.detail.cget('text')
                        self.clear_cursor()
                        self.tabs.select(2)
                        self.update_table()
                        assert self.tables['Optimiseur'].get_children()
                        self.result = 0
                        self.close()
                        return
                    if self.view != 'Time':
                        self.switch_view('Time')
            except (OSError, ValueError):
                self.connected = False
                self.label.configure(text='●  RUNTIME INDISPONIBLE', foreground=DOWN)
                self.runtime.configure(text='Reconnexion au moteur local…', foreground=MUTED)
                self.draw_depth(force=True)
                if self.tabs.select() and self.tabs.tab(self.tabs.select(), 'text') == 'Poly BTC':
                    self.update_table()
                self.pause.state(['disabled'])
            finally:
                self.future = None
            self.root.after(1000, self.poll)
            return
        self.future = self.worker.submit(self.client.snapshot, self.view == 'Time', self.version)
        self.root.after(60, self.poll)

    def toggle_pause(self):
        if not self.state or self.action is not None:
            return
        path = '/api/resume' if self.state['paused'] else '/api/pause'
        self.pause.state(['disabled'])
        self.action = self.worker.submit(self.client.request, path, True)

    def export(self):
        if self.action is not None:
            return
        filename = filedialog.asksaveasfilename(parent=self.root, defaultextension='.ndjson',
                                               initialfile='visualtrader-audit.ndjson')
        if filename:
            def export_to(path):
                Path(path).write_bytes(self.client.request('/api/audit', raw=True))
            self.action = self.worker.submit(export_to, filename)

    def render(self):
        s = self.state
        w = s['wallet']
        live = s['mode'] == 'live' and s['marketReady']
        status = 'BINANCE LIVE' if live else s['detail'].upper()
        self.label.configure(text='●  ' + status, foreground=UP if live else GOLD)
        self.price.configure(text=money(s['price']))
        for key, label in self.metrics.items():
            value = w[key]
            prefix = '+' if key == 'net' and value is not None and value > 0 else ''
            color = FG
            if key == 'net' and value:
                color = UP if value > 0 else DOWN
            label.configure(text=prefix + money(value), foreground=color)
        fast = s.get('fast')
        if fast:
            reach = fast['cycles60'] >= fast['target']
            self.runtime.configure(foreground=UP if reach else MUTED)
        review = s['review'][0]['reason'] if s['review'] else 'Validation en attente'
        self.book_note.configure(text=f"Spread  {money(s['spread'], 3)} pb")
        self.strategy.configure(text=s['strategy'] or 'Cash')
        candidate = s['waiting'] or s['nomination']
        self.decision.configure(text=f"Candidat {candidate} · {review}" if candidate else review)
        c = s['counts']
        lag = s['recent']['lagMs']
        if fast:
            self.runtime.configure(text=f"Rapide  {fast['cycles60']}/{fast['target']} cycles / 60 s   "
                                   f"·   Net {money(fast['wallet']['net'])} USDT")
        else:
            self.runtime.configure(text=f"{s['mode'].upper()}  #{s['session']}     "
                                   f"{s['strategy'] or 'Cash'}     {c['gaps']} manquantes     "
                                   f"Retard {lag if lag is not None else '—'} ms")
        self.draw_depth()
        self.pause.configure(text='Reprendre entrées' if s['paused'] else 'Pause entrées')
        self.pause.state(['!disabled'] if self.action is None else ['disabled'])
        self.redraw()
        self.update_table()

    def update_table(self):
        if not self.tabs.select():
            return
        s = self.state
        name = self.tabs.tab(self.tabs.select(), 'text')
        if name == 'Poly BTC':
            rows = self.polymarket_rows()
        elif not s:
            return
        elif name == 'Transactions':
            rows = [('down' if t['sell'] else 'up', clock(t['t']), 'Vente' if t['sell'] else 'Achat',
                     money(t['price']), money(t['size'], 6)) for t in s['tape']]
        elif name in ('Exécutions', 'Fills rapides'):
            fills = s['fills'] if name == 'Exécutions' else s.get('fast', {}).get('recent', [])
            rows = [('up' if f['side'] == 'BUY' else 'down', clock(f['time']), f['side'], money(f['price']),
                     money(f['qty'], 8), money(f['fee'], 4), str(f['latencyMs']) + ' ms', money(f['net'], 4), f['reason']) for f in fills]
        elif name == 'Optimiseur':
            rows = [('', c['id'], money(c['score']), money(c['net']), c['trades'], money(c['drawdown']))
                    for c in sorted(s['candidates'], key=lambda c: c['score'] if c['score'] is not None else -1000000,
                                    reverse=True)]
        elif name == 'Statistiques':
            w = s['wallet']
            rows = [('', label, value) for label, value in [
                ('P&L brut réalisé', money(w['gross'])),
                ('Net moyen par cycle', money(w.get('averageNet'), 4)),
                ('Cycles gagnants', f"{w['wins']} / {w['trades']}"),
                ('Profit factor', '∞' if w.get('profit', 0) and not w.get('loss') else money(w.get('profitFactor'))),
                ('Pire cycle', money(w.get('worst'), 4)),
                ('Écart cumulé vs signal', money(w['drag'], 4)),
                ('Fenêtre couverte', f"{s['covered']} / {s['config']['windowMs'] // 1000} s"),
                ('Frais / slippage par côté', f"{s['config']['feeBps']} / {s['config']['slipBps']} pb"),
            ]]
        elif name == 'Cadence':
            fast = s.get('fast')
            rows = []
            if fast:
                wallet = fast['wallet']
                rows = [('', label, value) for label, value in [
                    ('Cycles terminés / 60 s', f"{fast['cycles60']} / {fast['target']} visés"),
                    ('Exécutions / 60 s', fast['fills60']),
                    ('Minutes à la cible', f"{fast['qualifiedMinutes']} / {fast['fullMinutes']}"),
                    ('Cycles terminés cumulés', wallet['trades']),
                    ('P&L net réalisé · USDT', money(wallet['net'], 4)),
                    ('Frais cumulés · USDT', money(wallet['fees'], 4)),
                    ('Net moyen / cycle · USDT', money(wallet['averageNet'], 4)),
                    ('Capital liquidable · USDT', money(wallet['equity'], 4)),
                    ('Refus et annulations', fast['rejections']),
                    ('Cycles bénéficiaires', wallet['wins']),
                ]]
        elif name == 'Phoenix':
            rows = []
            if s.get('phoenix') and s.get('fast'):
                rapid, phoenix = s['fast'], s['phoenix']
                first, second = rapid['wallet'], phoenix['wallet']
                rows = [('', label, base, filtered) for label, base, filtered in [
                    ('Cycles / 60 s', rapid['cycles60'], phoenix['cycles60']),
                    ('P&L net · USDT', money(first['net'],4), money(second['net'],4)),
                    ('Frais · USDT', money(first['fees'],4), money(second['fees'],4)),
                    ('Net moyen / cycle', money(first['averageNet'],4), money(second['averageNet'],4)),
                    ('Cycles terminés', first['trades'], second['trades']),
                    ('Cycles gagnants', first['wins'], second['wins']),
                    ('Minutes à la cible', f"{rapid['qualifiedMinutes']}/{rapid['fullMinutes']}",
                     f"{phoenix['qualifiedMinutes']}/{phoenix['fullMinutes']}"),
                    ('Biais du filtre spot', '—', {'long':'Haussier','short':'Baissier'}.get(phoenix['bias'],'En attente')),
                    ('Signaux haussiers / baissiers', '—', f"{phoenix['signals']['long']} / {phoenix['signals']['short']}"),
                ]]
        elif name == 'Étude 4 h':
            rows = []
            if self.phoenix_research:
                for label, item in self.phoenix_research['results'].items():
                    base, stress, rules = item['holdout'], item['stress'], item['rules']
                    tag = 'up' if base['returnPct'] > 0 else 'down'
                    nameplate = f"{label} · {rules['leverage']}× · {money(rules['trail']*100,2)} %"
                    rows.append((tag, nameplate, money(base['returnPct']) + ' %',
                                 money(stress['returnPct']) + ' %', money(base['maxDrawdownPct']) + ' %',
                                 base['trades']))
                if not self.phoenix_research.get('candidatePassedSelection',False):
                    rows.insert(0,('down','Cash · référence','0,00 %','0,00 %','0,00 %',0))
        elif name == 'Archive 4 h':
            backtest = self.phoenix_backtest
            rows = []
            if backtest:
                rows = [('', label, value) for label, value in [
                    ('Période UTC', backtest['start'][:10] + ' → ' + backtest['end'][:10]),
                    ('Rendement portefeuille', money(backtest['profit'] * 100) + ' %'),
                    ('Drawdown maximal', money(backtest['drawdown'] * 100) + ' %'),
                    ('Cycles / taux de réussite', f"{backtest['cycles']} / {money(backtest['wins'] * 100)} %"),
                    ('Profit factor', money(backtest['profitFactor'])),
                    ('Funding comptabilisé · USDT', money(backtest['funding'])),
                    ('Levier de l’archive', ', '.join(money(x,0) + '×' for x in backtest['leverage'])),
                ]]
                rows += [('', pair['name'], f"{money(pair['net'])} USDT · {pair['cycles']} cycles")
                         for pair in backtest['pairs']]
                rows += [('', year, money(net) + ' USDT') for year, net in sorted(backtest['years'].items())]
        else:
            rows = [('', clock(r['time']), money(100 * r['coverage']) + ' %' if 'coverage' in r else '—',
                     r['reason']) for r in s['review']]
        key = name, rows
        if key == self.table_key:
            return
        self.table_key = key
        if not rows:
            rows = [('', '—', 'Aucune donnée')]
        table = self.tables[name]
        children = table.get_children()
        for i, (tag, *values) in enumerate(rows):
            tags = (tag, 'stripe') if i % 2 else (tag,)
            if i < len(children):
                table.item(children[i], tags=tags, values=values)
            else:
                table.insert('', 'end', tags=tags, values=values)
        if len(children) > len(rows):
            table.delete(*children[len(rows):])

    def polymarket_rows(self):
        path = Path(__file__).resolve().parent / 'data' / 'polymarket' / 'status.json'
        try:
            state = json.loads(path.read_text(encoding='utf8'))
        except (OSError, ValueError):
            return [('', 'Worker paper indisponible', '—', '—', '—', '—', '—')]
        age = (datetime.now().astimezone() -
               datetime.fromisoformat(state['checked'].replace('Z','+00:00'))).total_seconds()
        status = state['current']['state'] if age < 30 else 'Dernier rapport en cache'
        market = state['current']['slug'].removeprefix('btc-updown-5m-')
        rows = [('', f"BTC 5 min · {clock(int(market)*1000)}", f"{state['resolved']}/{state['evaluated']}",
                 '—', '—', '—', '—')]
        for key, label in [('anchor','Proxy BTC'),('momentum','+ Momentum'),('skew','+ Semivariance'),
                           ('market','Carnet · benchmark')]:
            item = state['summary'][key]
            rows.append(('up' if item['net'] > 0 else 'down' if item['net'] < 0 else '',
                         label,f"{item['trades']} / {item['settled']}",item['wins'],
                         money(item['fees'],4),money(item['net'],4),money(item['brier'],4)))
        rows.append(('', status, '—', '—', '—', '—', '—'))
        return rows

    def draw_depth(self, force=False):
        book = self.state['book'] if self.connected else None
        if not force and book == self.depth_key:
            return
        self.depth_key = book
        canvas = self.depth
        canvas.delete('all')
        width = canvas.winfo_width()
        canvas.create_text(1, 8, text='PRIX USDT', anchor='w', fill=MUTED)
        canvas.create_text(width - 2, 8, text='BTC', anchor='e', fill=MUTED)
        if not book:
            canvas.create_text(1, 43, text='En attente du carnet', anchor='w', fill=MUTED)
            return
        asks, bids = book['asks'][:3], book['bids'][:3]
        levels = list(reversed(asks)) + bids
        max_qty = max(qty for _, qty in levels) or 1
        for i, (price, qty) in enumerate(levels):
            y = 25 + 16 * i + (3 if i >= len(asks) else 0)
            ask = i < len(asks)
            color = DOWN if ask else UP
            canvas.create_rectangle(width * (1 - qty / max_qty), y - 7, width, y + 7,
                                    fill='#432c39' if ask else '#204139', outline='')
            canvas.create_text(2, y, anchor='w', text=money(price), fill=color, font=('Consolas', 8))
            canvas.create_text(width - 2, y, anchor='e', text=money(qty, 5), fill=FG, font=('Consolas', 8))

    def redraw(self):
        if self.state is None:
            return
        s = self.state
        candles = s['chart']
        if s['current'] and (not candles or s['current']['t'] > candles[-1]['t']):
            candles = [*candles, s['current']]
        limit = RANGES[self.view][self.range_var.get()]
        if self.view == 'Time':
            data = timeline(candles, self.history)
        elif self.view == 'Capital':
            data = [{'t': item['t'], 'c': item['value']} for item in s['equity']]
        else:
            data = candles
        data = data[-limit:]
        key = self.view, self.range_var.get(), data
        if key == self.chart_key:
            return
        self.chart_key = key
        chart = self.chart
        chart.delete('all')
        self.points.clear()
        self.cursor.clear()
        w, h = chart.winfo_width(), chart.winfo_height()
        usable = [item for item in data if item['c'] is not None]
        if not usable or w < 120 or h < 85:
            chart.create_text(w / 2, h / 2, text='En attente des données', fill=MUTED)
            self.detail.configure(text='En attente des données')
            return
        is_candle = self.view == '1 s'
        volume_visible = self.view != 'Capital' and h >= 160
        top, bottom = 14, h - (51 if volume_visible else 27)
        axis = self.axis
        left, right = 8, w - axis.measure('999 999,99') - 16
        self.chart_bounds = (left, top, right, bottom)
        high = max(item['h'] if is_candle else item['c'] for item in usable)
        low = min(item['l'] if is_candle else item['c'] for item in usable)
        pad = max(.01, (high - low) * .08)
        high, low = high + pad, low - pad

        def ordinate(value):
            return top + (high - value) / (high - low) * (bottom - top)

        for i in range(5):
            value = high - (high - low) * i / 4
            yy = ordinate(value)
            chart.create_line(left, yy, right, yy, fill=GRID)
            chart.create_text(right + 6, yy, anchor='w', text=money(value), fill=MUTED, font=axis)
        start, end = data[0]['t'], data[-1]['t']
        for i in range(5 if end != start else 1):
            x = left + 8 + (right - left - 16) * i / 4
            chart.create_line(x, top, x, bottom, fill=GRID)
            chart.create_text(x, h - 8, text=clock(start + (end - start) * i / 4), fill=MUTED,
                              anchor='w' if i == 0 else 'e' if i == 4 else 'center', font=axis)

        def draw_segment(points):
            if len(points) < 4:
                return
            if self.view == 'Time':
                chart.create_polygon(*points, points[-2], bottom, points[0], bottom, fill='#19372f', outline='')
            chart.create_line(*points, fill=UP, width=2)

        points, volumes = [], {}
        prev = None
        max_vol = max(.001, max(item.get('v', 0) for item in usable))
        body = max(2, min(8, (right - left) / len(data) * .6))
        for item in data:
            t, price = item['t'], item['c']
            x = left + 8 + (right - left - 16) * (t - start) / max(1, end - start)
            if price is None or prev is not None and t - prev > (60000 if self.view == 'Time' else 1000):
                draw_segment(points)
                points = []
            prev = t
            if price is None:
                continue
            y = ordinate(price)
            self.points.append((x, y, item))
            color = UP if not is_candle or price >= item['o'] else DOWN
            if volume_visible and item.get('v'):
                bucket = round(x / 4) * 4
                if item['v'] > volumes.get(bucket, (0, ''))[0]:
                    volumes[bucket] = item['v'], color
            if is_candle:
                chart.create_line(x, ordinate(item['h']), x, ordinate(item['l']), fill=color)
                opening = ordinate(item['o'])
                chart.create_rectangle(x - body / 2, min(y, opening), x + body / 2,
                                       max(y, opening) + 1, fill=color, outline='')
            else:
                points.extend((x, y))
        draw_segment(points)
        for x, (volume, color) in volumes.items():
            chart.create_line(x, h - 19, x, h - 19 - 20 * volume / max_vol,
                              fill='#547d72' if color == UP else '#87565c', width=2)
        _, yy, last = self.points[-1]
        chart.create_line(left, yy, right, yy, fill='#557f78', dash=(2, 5))
        chart.create_rectangle(right + 2, yy - 9, w - 1, yy + 9, fill=UP, outline='')
        chart.create_text(right + 6, yy, text=money(last['c']), fill=BG, anchor='w', font=axis)
        if len(self.points) == 1:
            x, y, _ = self.points[0]
            chart.create_oval(x - 2, y - 2, x + 2, y + 2, fill=UP, outline='')
        self.describe(last)
        if self.hover is not None:
            self.inspect_point(self.hover)

    def describe(self, item):
        line = f"{clock(item['t'])}    "
        if self.view == '1 s':
            line += "   ".join(f'{key.upper()} {money(item[key])}' for key in ('o', 'h', 'l', 'c'))
        else:
            line += f"{money(item['c'])} USDT"
        if 'v' in item:
            line += f"    Vol {money(item['v'], 4)} BTC"
        self.detail.configure(text=line)

    def inspect(self, event):
        self.inspect_point(event.x)

    def inspect_point(self, position):
        if not self.points:
            return
        self.hover = position
        index = bisect_left(self.points, position, key=lambda item: item[0])
        x, y, item = min(self.points[max(0, index - 1):index + 1], key=lambda item: abs(item[0] - position))
        left, top, right, bottom = self.chart_bounds
        coordinates = [(x, top, x, bottom), (left, y, right, y), (x - 3, y - 3, x + 3, y + 3)]
        if not self.cursor:
            chart = self.chart
            self.cursor = [chart.create_line(*coordinates[0], fill=MUTED, dash=(3, 3)),
                           chart.create_line(*coordinates[1], fill=MUTED, dash=(3, 3)),
                           chart.create_oval(*coordinates[2], fill=GOLD, outline=BG)]
        else:
            for cursor, coords in zip(self.cursor, coordinates):
                self.chart.coords(cursor, *coords)
        self.describe(item)

    def clear_cursor(self, _event=None):
        self.hover = None
        for item in self.cursor:
            self.chart.delete(item)
        self.cursor.clear()
        if self.points:
            self.describe(self.points[-1][2])


    def close(self):
        self.worker.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()


def configure_dpi():
    if sys.platform == 'win32':
        import ctypes
        ctypes.windll.user32.SetProcessDPIAware()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default=8787, type=int)
    parser.add_argument('--smoke', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    configure_dpi()
    root = tk.Tk()
    desktop = Desktop(root, Client(args.port), args.smoke)
    root.mainloop()
    return desktop.result if args.smoke else 0


if __name__ == '__main__':
    raise SystemExit(main())
