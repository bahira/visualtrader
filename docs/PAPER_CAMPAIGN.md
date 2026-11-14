# Campagne paper multi-journées

La campagne copie et hache les règles avant la première capture. Chaque bloc démarre avec le même inventaire initial indépendant. Le calcul compare à la liquidation du même inventaire passif. Aucun ordre réel, aucune clé d’échange et aucun ajustement des règles pendant la campagne.

```powershell
python -B paper_campaign.py --directory data/paper-campaign-01
Get-Content data/paper-campaign-01/status.json
```

Par défaut, 24 blocs de 10 minutes, un toutes les trois heures, sur environ 69 h 10. Les trois barèmes maker de 10, 2 et 0 pb sont rejoués avec les modèles de traversée, de file au meilleur prix et de stress. La machine doit rester allumée et connectée pour enregistrer toutes les fenêtres. Une interruption du processus laisse les fichiers précédents consultables. Un nouveau dossier démarre une nouvelle campagne.

Chaque bloc doit reconstruire au moins huit états de carnet par seconde de capture et présenter au moins une concordance bookTicker à ID égal. Les incohérences, sauts de séquence et fills traversant une lacune excluent le bloc. Les fichiers NDJSON, SQLite et les rapports restent locaux dans data. La collecte est bornée à la durée configurée et enregistre un échec lorsque l’espace disque libre descend sous 2 Gio.

Pour une qualification paper, il faut 24 blocs valides sur au moins trois dates UTC, 200 minutes simulées et, dans les trois modèles au barème maker de 10 pb, un P&L positif total et par jour ainsi qu’une moyenne d’au moins 10 cycles/minute. Les hypothèses de frais réduits restent des mesures de sensibilité. Le verdict ne déclenche aucun changement sur le moteur.

Les champs status et verdict décrivent respectivement la progression et la décision. Les échecs restent dans failures et le P&L cumulé dans summary. Les captures et résultats intermédiaires du dossier data ne sont pas versionnés.
