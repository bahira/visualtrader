# VisualTrader · résultats du 14 novembre 2026

| Journal paper v2 | Marchés réglés | Fills réglés | Net après frais |
| --- | ---: | ---: | ---: |
| Quant Skew | 18 | 7 | −15,78 USDC, soit environ −14,28 € |

Le taux BCE utilisé dans le film est de 1,1052 USD/EUR au 13 novembre 2026. La conversion suppose 1 USDC ≈ 1 USD. [Référence BCE](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)

## Comparaison des nouveaux indicateurs

Sur trois marchés historiques appariés dont le carnet et le flux Binance sont exploitables pour toutes les variantes, les probabilités donnent les scores suivants. Un Brier plus bas indique une meilleure prévision sur cet échantillon.

| Signal | Brier | Fills 250 / 500 / 1 000 ms | P&L stressé à 250 ms |
| --- | ---: | ---: | ---: |
| Carnet seul | 0,1075 | 0 / 0 / 0 | 0 USDC |
| Déséquilibre 30 s | 0,1145 | 0 / 0 / 0 | 0 USDC |
| Impulsion 10/30 s | 0,0845 | 1 / 0 / 0 | +4,50 USDC |
| Déséquilibre + impulsion | 0,0884 | 0 / 0 / 0 | 0 USDC |

L’impulsion mérite un bloc prospectif parce que l’exécution disparaît au-delà de 250 ms sur cet exemple. La combinaison des deux indicateurs a moins bien classé les trois résultats que l’impulsion seule et n’a déclenché aucun fill. Le résultat dépend d’un seul fill. Le journal de cohorte plus large inclut des marchés sans carnet CLOB complet et sert à l’analyse descriptive du flux.

## Exploitation

- Le premier banc fige le consensus, le proxy d’ouverture et le diagnostic de paire sur le bloc du 14 novembre à 21 h 10 au 28 novembre à 21 h 10, heure de Paris.
- Le benchmark Flux Binance actualise les statistiques toutes les cinq minutes. Son bloc prospectif débute à 21 h 20 le 14 novembre.
- Pour produire un rapport de réplication, conserver le manifeste, son empreinte, les journaux paper, les observations compactes du carnet, le journal spot et les rapports JSON. Le calcul prospectif, les commandes, et les 10 indispensables et 10 pistes suivantes figurent dans le [manuel du banc](POLY_EDGE.md).
