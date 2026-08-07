# Home Connect pour Gladys Assistant

Cette intégration relie Gladys à **Home Connect**, la plateforme cloud des
appareils électroménagers Bosch, Siemens, Neff, Gaggenau, Balay, Constructa,
Profilo et Thermador.

Tout appareil visible dans l'application Home Connect apparaît dans Gladys :
lave-vaisselle, lave-linge, sèche-linge, lavante-séchante, fours, micro-ondes,
tiroirs chauffants, tables de cuisson, hottes, réfrigérateurs, congélateurs,
caves à vin, machines à café, robots aspirateurs et robots culinaires.

> **Il n'y a pas de mode local.** Les appareils Home Connect dialoguent avec le
> cloud BSH, et uniquement avec lui. Sans connexion Internet, cette intégration
> ne fonctionne pas. C'est une propriété des appareils, pas de l'intégration.

## 1. Créer une application développeur Home Connect

L'API Home Connect est gratuite, mais chaque instance Gladys a besoin de **ses
propres** identifiants : BSH les délivre par développeur, pas par produit.

1. Créez un compte gratuit sur le
   [portail développeur Home Connect](https://developer.home-connect.com/) et
   connectez-vous. Utilisez **la même adresse e-mail que votre compte de
   l'application Home Connect** : le portail relie les deux, et c'est à cette
   condition que vous verrez vos propres appareils.
2. Allez dans **Applications → Register Application** et renseignez :
   - **Application ID** : ce que vous voulez, par exemple `gladys`.
   - **OAuth Flow** : **Authorization Code Grant Flow**.
   - **Home Connect User Account for Testing** : l'adresse e-mail de votre
     compte Home Connect.
   - **Redirect URI** : voir l'étape 2 ci-dessous, Gladys doit d'abord vous la
     donner.
   - **Success Redirect URI** : laissez vide.
3. Une fois l'application enregistrée, le portail affiche vos **Client ID** et
   **Client Secret**.

## 2. Configurer l'intégration dans Gladys

1. Installez l'intégration, puis ouvrez son onglet **Configuration**.
2. Collez le **Client ID** et le **Client Secret**.
3. Cliquez sur **Enregistrer**, puis sur **Connecter** au niveau du champ
   _Compte Home Connect_. Gladys ouvre la page de connexion Home Connect.

Si Home Connect répond « redirect_uri mismatch », c'est que l'URL utilisée par
Gladys n'est pas celle déclarée dans le portail. Cliquez une fois sur le bouton
**Tester la connexion** : il affiche l'URL de redirection exacte utilisée par
Gladys. Collez-la dans le champ **Redirect URI** de votre application
développeur, enregistrez sur le portail, puis cliquez de nouveau sur
**Connecter**.

4. Connectez-vous avec votre compte Home Connect et autorisez les permissions
   demandées.
5. De retour dans Gladys, ouvrez l'onglet **Découverte** : vos appareils sont
   listés, prêts à être ajoutés.

## 3. Ce que vous obtenez par appareil

Les fonctionnalités sont construites à partir de ce que chaque appareil déclare
réellement : deux appareils n'obtiennent donc jamais la même liste. En général :

| Fonctionnalité                                         | Type        | Appareils                     |
| ------------------------------------------------------ | ----------- | ----------------------------- |
| Alimentation                                           | on/off      | la plupart                    |
| Programme en cours                                     | on/off      | appareils à programmes        |
| Programme actif / sélectionné                          | texte       | appareils à programmes        |
| État de fonctionnement (`Run`, `Ready`, `Finished`…)   | texte       | tous                          |
| Temps restant, temps écoulé, progression               | capteur     | appareils à programmes        |
| Porte                                                  | ouverture   | la plupart                    |
| Démarrage à distance, commande à distance, usage local | capteur     | la plupart                    |
| Consignes réfrigérateur / congélateur                  | thermostat  | froid                         |
| Super mode, mode éco, mode vacances                    | on/off      | froid                         |
| Température du four                                    | température | fours                         |
| Éclairage, éclairage d'ambiance, luminosité            | lumière     | hottes, fours, réfrigérateurs |
| Sécurité enfant                                        | verrou      | appareils compatibles         |
| Compteurs de boissons                                  | compteur    | machines à café               |
| Alertes (sel, réservoir d'eau, filtre…)                | binaire     | selon la famille d'appareil   |
| Connecté                                               | binaire     | tous                          |

**Porte** suit la convention Gladys des détecteurs d'ouverture : la
fonctionnalité affiche _Fermé_ quand la porte est fermée et _Ouvert_ sinon (une
porte verrouillée compte comme fermée). Les **alertes** affichent _Off_ tant que
Home Connect ne les a pas déclenchées : un lave-vaisselle qui n'a jamais manqué
de sel montre une alerte au repos, et non une valeur vide.

### Démarrer un programme

**Programme en cours** démarre le programme **actuellement sélectionné sur
l'appareil** (ou dans l'application Home Connect) : il n'en choisit pas un à
votre place. C'est exactement ce que les appareils autorisent — un démarrage à
distance est un déclencheur, pas un sélecteur de programme.

Pour que cela fonctionne, le **démarrage à distance doit être armé** sur
l'appareil : sur la plupart des modèles, un appui long sur la touche _Démarrage
à distance_ jusqu'à confirmation à l'écran. Sans cela, Home Connect refuse la
commande et Gladys affiche le message de refus.

Repasser **Programme en cours** sur « éteint » interrompt le programme.

## 4. Comment les états restent à jour

L'intégration maintient ouvert un **flux d'événements** permanent vers Home
Connect : une porte qui s'ouvre ou un programme qui se termine arrive dans
Gladys en une seconde environ — y compris les actions faites directement sur
l'appareil.

Le polling (par défaut toutes les 15 minutes) tourne derrière, en filet de
sécurité, car Home Connect coupe le flux environ une fois par jour. Home Connect
applique un quota de requêtes : gardez un intervalle élevé sauf raison
particulière.

## 5. Tester sans appareil

Activez **Utiliser le simulateur Home Connect** dans la configuration.
L'intégration s'adresse alors à `simulator.home-connect.com`, qui sert la même
API sur les appareils virtuels de votre compte développeur. Pensez à le
désactiver ensuite.

## 6. Dépannage

**« Renseignez vos Client ID et Client Secret Home Connect »** — les identifiants
sont absents ou vides.

**« Cliquez sur Connecter pour lier votre compte Home Connect »** — les
identifiants sont là, mais le flux OAuth n'a jamais été mené à son terme.

**« L'intégration a refusé la connexion. Réessayez. »** dans la fenêtre de
retour d'autorisation — l'échange du code d'autorisation a échoué. Ouvrez les
logs de l'intégration : le message y donne la raison exacte donnée par Home
Connect (Client Secret manquant, URL de redirection non déclarée dans le portail
développeur, code déjà utilisé…). Si vous avez redémarré l'intégration ou la
machine pendant que vous vous connectiez chez Home Connect, relancez simplement
**Connecter** : une autorisation reste valable quinze minutes.

Après un **Connecter** réussi, la fenêtre se ferme immédiatement et
l'état de la connexion affiche « Compte connecté, lecture de vos appareils… » :
la lecture du compte Home Connect se poursuit en arrière-plan et peut prendre
quelques secondes par appareil.

**« Autorisation Home Connect expirée »** — le refresh token a été refusé. Il
expire après environ deux mois sans utilisation, et il est également révoqué si
vous retirez Gladys des applications autorisées de votre compte Home Connect.
Cliquez de nouveau sur **Connecter**.

**« Quota Home Connect atteint »** — trop de requêtes. L'intégration lève le pied
d'elle-même ; augmentez l'intervalle de rafraîchissement si cela se répète.

**Un appareil affiche un badge orange « injoignable »** — c'est Home Connect
lui-même qui ne le joint pas. Vérifiez dans l'application Home Connect qu'il est
allumé et connecté à votre Wi-Fi.

**Une commande est refusée** — Gladys affiche la raison donnée par Home Connect.
Les plus fréquentes : _démarrage à distance non activé_, _porte ouverte_ et
_appareil éteint_.

L'intégration journalise tout ce qu'elle fait : passez `LOG_LEVEL=debug` et
consultez les logs de l'intégration depuis l'interface Gladys pour le détail
complet.
