"""VisualTrader's native desktop client. Requires Python 3.10+ and Tk."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from concurrent.futures import ThreadPoolExecutor
from urllib.request import build_opener, ProxyHandler, Request

BG, PANEL, GRID = '#111515', '#182020', '#303b39'
FG, MUTED, UP, DOWN, GOLD = '#eef5f2', '#a8b6b1', '#73e8bd', '#ffa3a0', '#e9ce78'


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
        self.view = '1 s'
        self.chart_key = None
        self.table_key = None
        self.result = 1
        root.configure(bg=BG)
        root.title('VisualTrader | BTC/USDT')
        root.geometry('1150x760')
        root.minsize(780, 580)
        root.protocol('WM_DELETE_WINDOW', self.close)
        self.style()
        frame = ttk.Frame(root, padding=14)
        frame.pack(fill='both', expand=True)
        top = ttk.Frame(frame)
        top.pack(fill='x')
        ttk.Label(top, text='BTC / USDT', style='Title.TLabel').pack(side='left')
        self.label = ttk.Label(top, anchor='e', style='Muted.TLabel')
        self.label.pack(side='right')
        self.stats = ttk.Label(frame, style='Stats.TLabel')
        self.stats.pack(fill='x', pady=(7, 11))
        controls = ttk.Frame(frame)
        controls.pack(fill='x')
        self.view_var = tk.StringVar(value=self.view)
        for view in ('1 s', 'Time', 'Capital'):
            ttk.Radiobutton(controls, text=view, value=view, variable=self.view_var,
                            command=self.select_view).pack(side='left', padx=(0, 12))
        self.pause = ttk.Button(controls, text='Pause entrées', command=self.toggle_pause, state='disabled')
        self.pause.pack(side='right')
        self.chart = tk.Canvas(frame, background=PANEL, highlightthickness=0, height=330)
        self.chart.pack(fill='both', expand=True, pady=(7, 10))
        self.chart.bind('<Configure>', self.resize)
        self.book_note = ttk.Label(frame, style='Muted.TLabel')
        self.book_note.pack(fill='x')
        self.tabs = ttk.Notebook(frame)
        self.tabs.pack(fill='x', pady=(9, 0))
        self.tables = {}
        self.table('Carnet', [('Côté', 70), ('Prix USDT', 145), ('BTC', 120)])
        self.table('Transactions', [('Heure', 100), ('Côté', 70), ('Prix USDT', 140), ('BTC', 120)])
        self.table('Exécutions', [('Heure', 85), ('Côté', 60), ('Prix USDT', 105),
                                  ('BTC', 105), ('Frais', 85), ('Net cycle', 90), ('Motif', 185)])
        self.table('Optimiseur', [('Stratégie', 120), ('Score pb', 100), ('Net réalisé', 110),
                                 ('Cycles', 70), ('Drawdown', 105)])
        self.table('Statistiques', [('Indicateur', 235), ('Valeur', 270)])
        self.table('Décisions', [('Heure', 95), ('Couverture', 100), ('Motif', 480)])
        self.tabs.bind('<<NotebookTabChanged>>', self.tab_changed)
        bottom = ttk.Frame(frame)
        bottom.pack(fill='x', pady=(8, 0))
        self.runtime = ttk.Label(bottom, style='Muted.TLabel')
        self.runtime.pack(side='left', fill='x', expand=True)
        ttk.Button(bottom, text='Exporter le journal', command=self.export).pack(side='right')
        self.poll()
        if smoke:
            root.after(8000, self.close)

    def style(self):
        style = ttk.Style(self.root)
        style.theme_use('clam')
        style.configure('.', background=BG, foreground=FG, font=('Segoe UI', 10))
        style.configure('Title.TLabel', font=('Segoe UI Semibold', 25), foreground=UP)
        style.configure('Stats.TLabel', font=('Consolas', 12))
        style.configure('Muted.TLabel', foreground=MUTED)
        style.configure('Treeview', background=PANEL, fieldbackground=PANEL, foreground=FG,
                        rowheight=22, borderwidth=0, font=('Consolas', 10))
        style.configure('Treeview.Heading', background=GRID, foreground=FG)
        style.configure('TButton', background=GRID, padding=5)
        style.configure('TNotebook.Tab', padding=(10, 4))
        style.map('Treeview', background=[('selected', '#315448')])
        style.map('TButton', background=[('active', '#315448')])
        style.map('TNotebook.Tab', background=[('selected', '#315448')])

    def table(self, name, columns):
        pane = ttk.Frame(self.tabs)
        grid = ttk.Treeview(pane, columns=list(range(len(columns))), show='headings', height=5)
        for i, (label, width) in enumerate(columns):
            grid.heading(i, text=label, anchor='w')
            grid.column(i, width=width, minwidth=45, stretch=True)
        scrollbar = ttk.Scrollbar(pane, orient='vertical', command=grid.yview)
        grid.configure(yscrollcommand=scrollbar.set)
        grid.tag_configure('up', foreground=UP)
        grid.tag_configure('down', foreground=DOWN)
        grid.pack(side='left', fill='both', expand=True)
        scrollbar.pack(side='right', fill='y')
        self.tables[name] = grid
        self.tabs.add(pane, text=name)

    def resize(self, _event):
        self.chart_key = None
        self.redraw()

    def select_view(self):
        self.view = self.view_var.get()
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
                self.render()
                if self.smoke and state['marketReady'] and state['chart']:
                    if self.view == 'Time' and (self.history or state['mode'] != 'live'):
                        assert self.chart.find_all() and self.tables['Carnet'].get_children()
                        self.result = 0
                        self.close()
                        return
                    self.view_var.set('Time')
                    self.select_view()
            except (OSError, ValueError):
                self.label.configure(text='PAPER TRADING | Runtime indisponible')
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
        status = 'BINANCE LIVE' if s['mode'] == 'live' and s['marketReady'] else s['detail']
        self.label.configure(text='PAPER TRADING | ' + status)
        self.stats.configure(text=f"{money(s['price'])} USDT   Capital {money(w['equity'])}   "
                             f"Net {money(w['net'])}   Frais {money(w['fees'])}   DD {money(w['drawdown'])}")
        review = s['review'][0]['reason'] if s['review'] else 'Validation en attente'
        self.book_note.configure(text=f"Spread {money(s['spread'], 3)} pb   |   "
                                 f"Actif {s['strategy'] or 'Cash'}   |   Candidat {s['nomination'] or '—'}   |   {review}")
        c = s['counts']
        lag = s['recent']['lagMs']
        self.runtime.configure(text=f"{s['mode']} #{s['session']}  |  {c['candle']} bougies  "
                               f"{c['trade']} trades  {c['book']} carnets  |  "
                               f"{c['gaps']} manquantes  |  retard {lag if lag is not None else '—'} ms")
        self.pause.configure(text='Reprendre entrées' if s['paused'] else 'Pause entrées')
        self.pause.state(['!disabled'] if self.action is None else ['disabled'])
        self.redraw()
        self.update_table()

    def update_table(self):
        if not self.state or not self.tabs.select():
            return
        s = self.state
        name = self.tabs.tab(self.tabs.select(), 'text')
        if name == 'Carnet':
            book = s['book'] or {'bids': [], 'asks': []}
            rows = [(tag, side, money(price), money(size, 6))
                    for tag, side, levels in [('down', 'Ask', reversed(book['asks'][:5])),
                                               ('up', 'Bid', book['bids'][:5])]
                    for price, size in levels]
        elif name == 'Transactions':
            rows = [('down' if t['sell'] else 'up', clock(t['t']), 'Vente' if t['sell'] else 'Achat',
                     money(t['price']), money(t['size'], 6)) for t in s['tape']]
        elif name == 'Exécutions':
            rows = [('up' if f['side'] == 'BUY' else 'down', clock(f['time']), f['side'], money(f['price']),
                     money(f['qty'], 8), money(f['fee'], 4), money(f['net'], 4), f['reason']) for f in s['fills']]
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
        else:
            rows = [('', clock(r['time']), money(100 * r['coverage']) + ' %' if 'coverage' in r else '—',
                     r['reason']) for r in s['review']]
        key = name, rows
        if key == self.table_key:
            return
        self.table_key = key
        table = self.tables[name]
        children = table.get_children()
        for i, (tag, *values) in enumerate(rows):
            if i < len(children):
                table.item(children[i], tags=(tag,), values=values)
            else:
                table.insert('', 'end', tags=(tag,), values=values)
        if len(children) > len(rows):
            table.delete(*children[len(rows):])

    def redraw(self):
        if self.state is None:
            return
        s = self.state
        candles = s['chart']
        if s['current'] and (not candles or s['current']['t'] > candles[-1]['t']):
            candles = [*candles, s['current']]
        if self.view == 'Time':
            data = timeline(candles, self.history)
        elif self.view == 'Capital':
            data = [{'t': item['t'], 'c': item['value']} for item in s['equity']]
        else:
            data = candles[-100:]
        key = self.view, data[-1:], len(data), self.version if self.view == 'Time' else None
        if key == self.chart_key:
            return
        self.chart_key = key
        chart = self.chart
        chart.delete('all')
        w, h = chart.winfo_width(), chart.winfo_height()
        title = {'1 s': 'OHLCV · 1 seconde', 'Time': 'Time · clôtures 1 min', 'Capital': 'Capital liquidable · USDT'}[self.view]
        chart.create_text(12, 13, anchor='w', text=title, fill=MUTED)
        usable = [item for item in data if item['c'] is not None]
        if not usable or w < 120 or h < 90:
            return
        is_candle = self.view == '1 s'
        bottom = h - (55 if self.view != 'Capital' else 30)
        high = max(item['h'] if is_candle else item['c'] for item in usable)
        low = min(item['l'] if is_candle else item['c'] for item in usable)
        pad = max(.01, (high - low) * .07)
        high, low = high + pad, low - pad
        for i in range(5):
            yy = 30 + (bottom - 30) * i / 4
            chart.create_line(12, yy, w - 88, yy, fill=GRID)
            chart.create_text(w - 80, yy, anchor='w', text=money(high - (high - low) * i / 4), fill=MUTED)
        start, end = data[0]['t'], data[-1]['t']
        max_vol = max(.001, max(item.get('v', 0) for item in usable))
        segments, points, volumes = [], [], []
        prev = None

        def ordinate(value):
            return 30 + (high - value) / (high - low) * (bottom - 30)

        for item in data:
            t, price = item['t'], item['c']
            x = 16 + (w - 110) * (t - start) / max(1, end - start)
            if price is None or prev is not None and t - prev > (60000 if self.view == 'Time' else 1000):
                if len(points) >= 4:
                    segments.append(points)
                points = []
            prev = t
            if price is None:
                continue
            if item.get('v'):
                volumes.append((x, item['v']))
            y = ordinate(price)
            if is_candle:
                color = UP if price >= item['o'] else DOWN
                chart.create_line(x, ordinate(item['h']), x, ordinate(item['l']), fill=color)
                chart.create_line(x, y, x, ordinate(item['o']) + .25, width=3, fill=color)
            else:
                points.extend((x, y))
        if len(points) >= 4:
            segments.append(points)
        for segment in segments:
            chart.create_line(*segment, fill=UP, width=2)
        # Reduce volume bars on the long view to one shape per horizontal bucket.
        bins = {}
        for x, volume in volumes:
            bucket = round(x / 4) * 4
            bins[bucket] = max(volume, bins.get(bucket, 0))
        for x, volume in bins.items():
            chart.create_line(x, h - 25, x, h - 25 - 19 * volume / max_vol, fill='#4d776b')
        for i in range(5):
            t = start + (end - start) * i / 4
            chart.create_text(35 + (w - 151) * i / 4, h - 11, text=clock(t), fill=MUTED)

    def close(self):
        self.worker.shutdown(wait=False, cancel_futures=True)
        self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default=8787, type=int)
    parser.add_argument('--smoke', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = tk.Tk()
    desktop = Desktop(root, Client(args.port), args.smoke)
    root.mainloop()
    return desktop.result if args.smoke else 0


if __name__ == '__main__':
    raise SystemExit(main())
