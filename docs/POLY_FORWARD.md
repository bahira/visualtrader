# Évaluation prospective Polymarket

Le banc `poly_research.mjs` compare le carnet seul, l'ancre Binance, Momentum, Skew et deux variantes fondées sur la moyenne de 60 clôtures Binance à une seconde. Le prix moyen Binance est un proxy. Il n'est pas labellisé Chainlink.

Le modèle proxy passe du prix moyen à une distance au seuil normalisée par la volatilité et le temps restant. Il applique une correction bornée au logit du carnet. La variante Drift y ajoute une correction de momentum bornée quand son signe concorde avec celui de l'écart au seuil. Les coefficients sont fixés dans le code. Aucun poids n'est estimé sur le bloc de test.

## Exécution et comparaison

Les variantes choisissent le côté qui dépasse le coût estimé de 4 cents par part. Elles utilisent le même snapshot de départ et le même premier carnet CLOB admissible par côté et délai. Les ordres de 10 parts qui ne passent plus le seuil au premier état disponible sont refusés. Les délais testés sont 250, 500 et 1 000 ms. L'échéance d'exécution reste la fin de la fenêtre de décision à +138 s. Les frais par niveau proviennent des métadonnées du marché. Aucun ordre réel n'est émis.

Le moteur archive les observations d'exécution en SQLite avant ou après règlement selon leur disponibilité, afin que la rotation ultérieure du CLOB ne change pas les résultats observés. Les observations sont indexées par empreinte de politique, marché, décision, côté et latence. Le résultat de chaque replay de carnet est partagé par les variantes. Les trous de capture restent inconnus et sont comptés séparément.

## Bloc prospectif

Le bloc commence à 20 h 50 heure de Paris le 14 novembre 2026. Les marchés précédents servent au diagnostic. Seuils préfixés : au moins 300 marchés évaluables, 30 fills et cinq journées UTC avec fills, une couverture d'exécution d'au moins 95 %, du P&L positif et supérieur au carnet seul, et un Brier inférieur au carnet. Chaque journée doit avoir un résultat non négatif. Ces exigences s'appliquent aux trois latences. Le verdict positif est uniquement une qualification paper. Cet ensemble de seuils n'est pas un test d'inférence statistique formel. Les marchés absents du journal ou de la capture ne peuvent pas être rejoués.

```powershell
node poly_research.mjs
node poly_research.mjs --watch
Get-Content data/polymarket-v2/research.json
node --test test/poly_research.test.mjs
```

Le mode watch actualise le rapport chaque minute. L'étude est indépendante de la boucle de décision du simulateur. Les entrées et sorties de production restent protégées par leurs propres verrous. Le résultat n'active aucune variante. Connecter le [TWAP exact](https://docs.polymarket.com/market-data/realtime-data#twap-prices) requiert un accès authentifié aux données. Le WebSocket public ne permet pas de prouver qu'aucune mise à jour n'a été perdue.
