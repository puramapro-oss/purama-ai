---
name: business
description: "Pricing,Stripe,parrainage,concours,monétisation,influenceur,viralité,aide SAV,/financer 45 aides remboursement,légal,SEO,emails,notifs,points,challenge stake,communauté,partnership."
---
**Structure**:SASU=Stripe|Asso(Solenne DORNIER)=subventions.
**PRICING**:BRIEF→5 concurrents(Tavily)→prix dessous.-33% annuel.14j essai.Stripe:card+paypal+link.DÉFAUT=Free+Premium.EXCEPTION=Free→Starter→Pro→Unlimited→Enterprise.
**CONVERSION**:/pricing(5 cartes glass,Pro"⭐POPULAIRE",annuel GROS+barré"-33%",vrais avis DB,14j).Popup(JAMAIS 1er/>1/session/<7j)triggers:limite|gains|premium|3ème connexion.
**i18n**:next-intl fr.16 langues(fr,en,es,de,it,pt,ar,zh,ja,ko,hi,ru,tr,nl,pl,sv).
**Parrainage**:Bronze5→Argent10→Or25→Platine50→Diamant75→Légende100.Wallet 5-1000€ IBAN dès 5€.Niv2=5%|Niv3=2%.Anti-fraude:30j activité RÉELLE.
**CONCOURS**:10 gagnants.CRONs n8n.Hebdo(dim23h59):6%CA(1er2%|2ème1%|3ème0.7%|4ème0.5%|5ème0.4%|6ème0.3%|7-10ème1.1%).Mensuel:4%CA(1er1.2%|2ème0.8%|3ème0.6%|4ème0.4%|5-10ème1%).reward_pool(10%CA).
**RÉPARTITION**:90%SASU+10%users(classement6%+tirage4%).
**FLUX**:Stripe=90%SASU+10%reward_pool.Partenaires→85%wallet+15%Purama.
**MONÉTISATION**:€réel=payants.Gratuits=Points.Seuil→"💰[X]€ en attente!Passe à Starter!"
**INFLUENCEUR**:/devenir-influenceur.50%1er+10%récurrent vie.Paliers:10→50€|25→150€|50→400€|100→1K€|250→3K€|500→6.5K€|1K→11.1K€|5K→50K€|10K→100K€.Commission:Bronze(10)10%|Argent(25)11%|Or(50)12%|Platine(100)13%|Diamant(250)15%|Légende(500)17%|Titan(5K)20%|Éternel(10K)25%.Avantages:Bronze=Starter GRATUIT|Or=Unlimited+page|Légende=héréditaires|Éternel=1%parts.
**VIRALITÉ**:Challenges amis|Cartes(1080²+1080×1920+1200×675)|partage/j=+100|Abo groupe(3=-20%|5=-30%)|Streak(J7×2|J14×3|J30×5|J60×7|J100×10)|Heure dorée×3 1h/sem|Story 1080×1920→réseaux→+300pts.
**Cinématique**:3-4s,skip,intro_seen.Tuto:SVG mask+spotlight+spring,7-10 étapes.
**SAV**:/aide FAQ 15+→chatbot IA"💬"=SAV 100% auto,tutoie,emojis,jamais dit IA.Si humain→escalade(prénom,email,msg)→Resend→purama.pro@gmail.com.Email auto:n8n→Claude→Resend.
## /financer — REMBOURSEMENT ULTIME
/financer menu+footer+CTA pricing+popup inscription("Abo 100% remboursé?").Client paye JAMAIS.
**WIZARD 4É**:É1—Profil?(Particulier/Entreprise/Asso/Étudiant)→Situation?(Salarié/DE/Indépendant/Auto/Retraité/RSA/CEJ)→Département?(carte)→Handicap?→stocker DB|É2—IA matching→aides triées montant DESC+badge(✅Probable/🟡Possible/🔵Vérifier)+CUMUL"Coûte 0€,récupérez [X]€"|É3—PDF jsPDF:en-tête+identité+descriptif app+justificatif+Qualiopi+lien officiel.Multi→ZIP|É4—Dashboard suivi(En cours/Accepté✅/Refusé❌/Renouveler🔄)+CRON n8n 30j avant expiration→régénère auto.
**45 AIDES**:PART(20):1.CPF 5K€|2.AIF|3.Chèque CAF|4.Pass Num 10-20€|5.Prime activité|6.AGEFIPH 10K€|7.FIPHFP|8.Mob jeunes|9.CROUS|10.Pass Culture 300€|11.Micro-crédit 5K€|12.OPCO|13.1jeune1solution|14.Garantie Jeunes 500€/m|15.PLIE|16.RSA|17.FNE 100%|18.Transition Pro 100%|19.VAE|20.PE num.ENT(15):21.France Num 6.5K€|22.Pack IA 18.5K€|23.OPCO IA|24.BFC num|25.CIR 30%|26.CII 20%|27.FNE IA|28.TPE CCI 1.5K€|29.AGEFIPH ent|30.DIRECCTE|31.Diag BFC 50%|32.BPI 300K€|33.DETR|34.FEDER|35.Santé.ASSO(10):36.FDVA2 15K€|37.FDVA3|38.Commune|39.LEADER 20K€|40.Dépt|41.BFC|42.Fondation France 15K€|43.Mécénat 60%|44.Google Grants 10K$|45.France Active.
**SCRIPTS VENTE**:Auto-entrepreneur→"AGEFICE 100%+chèque 500€"|DE→"CPF+ARE 0€"|PME→"IA Booster 80%+OPCO+CIR=PLUS"|Asso→"FDVA 25K€"|Étudiant→"Pass Culture".
**BANDEAU**:CHAQUE plan payant→vert"💰 Plupart clients paient rien.[Vérifier→/financer]".
**TABLE `aides`**:id|nom|type_aide enum|profil_eligible[]|situation_eligible[]|montant_max|taux_remboursement|url_officielle|description|region|handicap_only|cumulable|renouvellement_auto|active.+`dossiers_financement`:id|user_id|aide_id|app_slug|statut enum|dates|pdf_url|metadata.
**Légal**:/mentions-legales,/confidentialite(RGPD),/cgv,/cgu,cookies.art.293B.
**SEO**:sitemap|robots|meta|OG Satori|JSON-LD|LCP<2.5s|16langues.
**EMAILS**:10/app Resend+n8n.J0:Bienvenue|J1:Astuce|J3:Relance|J7:Tips|J14:-20% 48h|J21:Témoignage|J30:Win-back|Evt:Parrainage/Concours/Palier.
**NOTIFS**:Score>80=2/sem|50-80=3|<50=1.JAMAIS>1/j,20h-9h.
**POINTS**:1pt=0.01€.Gagner:mission50-1000|inscription100|parrainage200|streak10/j|achievements50-500|avis500|partage300.Dépenser:1K=-10%|3K=-30%|5K=-50%|10K=1mois.Conversion:25K=2.50€|100K=10€.Retrait 5€.
**DAILY GIFT**:40%pts|25%coupon|15%ticket|10%crédits|5%-20%|3%gros pts|2%-50%.
**CROSS-PROMO**:/ecosystem.MIDAS→KASH,SUTRA→AETHER,KAÏA→PRANA.-50% CROSS50.
## CHALLENGE STAKE(santé/sport BRIEF)
7/30/90j→stake 10-200€→1tâche/j+preuve→Réussi=récupère+jackpot|Échoué→redistribuée.Ligues Bronze→Legend.Anti-fraude:Proof-of-Progress.Trust Score 0→100.
## COMMUNAUTÉ
Cercles 5-12|Buddy duo×2pts|Mur /love 0 toxicité|Missions collectives→ONG|Cérémonies hebdo|Lettres motivation→+500pts|Mentorat 90j.
## PARTNERSHIP
4 canaux.Codes+QR+NFC.Cookie 30j./partenariat,/scan/[code],/p/[slug].Classements|saisons×2|badges.Anti-fraude:1/IP/24h,14j,reCAPTCHA v3.
