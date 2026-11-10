# Invitation et provenance du téléchargement

Le bandeau et les présentations du programme influenceur promettaient une remise de 50 % pendant la première année. Les données lues ne contiennent ni une politique de remise admise ni une durée de une ou trois mensualités. Le correctif conserve le code et l’identité de l’invitation et renvoie aux prix et conditions avant paiement. Aucun calcul, produit fournisseur, montant, durée ou attribution n’est ajouté.

Le téléchargement reconstruisait les conditions courantes et apposait un cartouche « SIGNÉ ÉLECTRONIQUEMENT » à partir de `contract_signed_at`. Aucun PDF original ni version des conditions acceptées ne figure dans ce modèle de lecture. Le générateur produit désormais un récapitulatif actuel explicitement non signé ; le bouton, la notification, les métadonnées PDF et le nom du fichier le disent. Le document contient les informations courantes du compte, pas une réédition de clauses signées. La date de signature n’est plus transmise au générateur. La signature et les données stockées ne sont pas modifiées.

## Qualification bornée

- Impacts GitNexus avant modification : ReferralBanner LOW ; generateContractPdf LOW ; InfluencerDashboard UNKNOWN (route lazy vérifiée manuellement dans App.tsx).
- Lint ciblé des trois fichiers : code0, aucune erreur, un avertissement préexistant de dépendance de hook dans ReferralBanner.
- Une fixture synthétique a exécuté le vrai générateur et le jsPDF installé avant/après. L’adaptateur Node ajuste uniquement la forme des exports CommonJS du même constructeur. Les textes PDF et leurs empreintes sont conservés.
- Avant : une date synthétique de 2001 suffisait à produire le cartouche de signature et la promesse annuelle. Après : identité de l’invitation conservée, aucune date de signature ancienne, mention non signé et demande du document original.
- La page finale a été rendue et examinée ; aucune coupure ou superposition avec MuPDF. Le premier rendu Poppler, dont la substitution de polices standard était inexacte dans l’environnement local, est conservé dans les preuves externes.
- Aucun test miroir du simple texte promotionnel n’a été ajouté. Les suites globales, le build et les fournisseurs n’ont pas été relancés pour ce delta ; l’assemblage conserve ses propres portes de validation.

## BLOQUÉ : contrat historique original

Ce correctif empêche une présentation trompeuse du téléchargement. Il ne récupère ni ne reconstitue un contrat historique signé. La copie originale ou une version signée effectivement conservée doit être retrouvée et admise avant de proposer ce téléchargement comme preuve contractuelle. Aucune version passée, signature, autorité de prix ou preuve fournisseur n’est fabriquée.

Les autres programmes CROSS50 et Parrainage sont hors de ce delta ; la recherche ciblée n’a pas donné lieu à un audit de ces modules.
