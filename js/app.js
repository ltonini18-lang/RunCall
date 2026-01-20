// js/app.js

document.addEventListener('DOMContentLoaded', async () => {
    
    // --- 1. Initialisation SUPABASE ---
    const SUPABASE_URL = "https://bflptoazeqfcultpukkh.supabase.co";
    const SUPABASE_PUBLISHABLE_KEY = "sb_publishable__ZleRKOics4yZv3UwIUPiA_22xmqUM4";
    
    // On vérifie que Supabase est bien chargé
    if (typeof window.supabase === 'undefined') {
        console.error("Supabase Library not loaded.");
        return;
    }
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);


    // --- 2. Gestion des Langues (Global) ---
    const buttons = document.querySelectorAll('.lang-switch button');
    let lang = localStorage.getItem('runcall_lang');
    if (!lang) {
        const browserLang = (navigator.language || "").toLowerCase();
        lang = browserLang.startsWith('fr') ? 'fr' : 'en';
    }

    function applyLanguage(nextLang) {
        document.querySelectorAll('[data-fr][data-en]').forEach(el => {
            el.textContent = el.dataset[nextLang];
        });
        buttons.forEach(btn => btn.classList.toggle('active', btn.dataset.lang === nextLang));
        localStorage.setItem('runcall_lang', nextLang);
        lang = nextLang;
    }
    
    buttons.forEach(btn => btn.addEventListener('click', () => applyLanguage(btn.dataset.lang)));
    applyLanguage(lang);


    // --- 3. Logique Spécifique à la PAGE LANDING EXPERT ---
    // On détecte si on est sur la page landing-expert.html
    const googleBtn = document.getElementById("googleBtn");
    const magicForm = document.getElementById("magicForm");

    if (googleBtn && magicForm) {
        console.log("Landing Expert logic loaded.");
        
        const googleBtnLabel = document.getElementById("googleBtnLabel");
        const magicBtn = document.getElementById("magicBtn");
        const msgBox = document.getElementById("msgBox");
        let inFlight = false;

        // URL de retour après auth : on revient sur CETTE page pour que le script finisse le travail
        // Grâce à config.js, on pourrait utiliser CONFIG.URLS.landing si défini, sinon l'URL courante
        const RETURN_URL = window.location.href.split('?')[0]; 

        // -- Helpers d'affichage --
        function showMsg(type, text){
            msgBox.className = "start-msg " + (type === "error" ? "is-error" : "is-ok");
            msgBox.style.display = "block";
            msgBox.textContent = text;
        }
        function clearMsg(){
            msgBox.style.display = "none";
            msgBox.textContent = "";
            msgBox.className = "start-msg";
        }
        function setGoogleLoading(isLoading){
            googleBtn.disabled = isLoading;
            googleBtnLabel.textContent = isLoading
              ? (lang === "fr" ? "Chargement..." : "Loading...")
              : (lang === "fr" ? googleBtnLabel.dataset.fr : googleBtnLabel.dataset.en);
        }
        function setMagicLoading(isLoading){
            magicBtn.disabled = isLoading;
            magicBtn.textContent = isLoading
              ? (lang === "fr" ? "Chargement..." : "Loading...")
              : (lang === "fr" ? magicBtn.dataset.fr : magicBtn.dataset.en);
        }

        // -- Fonction principale : Création/Récupération Expert en base --
        async function ensureIntervenantRowAndRedirect(user){
            const authUserId = user.id;
            const email = (user.email || "").trim().toLowerCase() || null;
            const md = user?.user_metadata || {};
            const name = (md.full_name || md.name || "").trim();
          
            // A) Chercher si l'expert existe déjà
            const { data: existing, error: findErr } = await supabase
              .from("experts")
              .select("id, auth_user_id")
              .eq("auth_user_id", authUserId)
              .maybeSingle();
          
            if (findErr) throw findErr;
          
            let targetExpertId = null;

            if (existing?.id) {
                // B) Mise à jour
                targetExpertId = existing.id;
                await supabase.from("experts").update({
                    email,
                    name,
                    updated_at: new Date().toISOString()
                }).eq("id", existing.id);
            } else {
                // C) Création
                const { data: created, error: insErr } = await supabase
                  .from("experts")
                  .insert({
                    auth_user_id: authUserId,
                    email,
                    name,
                    presentation: "",
                    status: "draft"
                  })
                  .select("id")
                  .single();
                if (insErr) throw insErr;
                targetExpertId = created.id;
            }

            // D) REDIRECTION propre via CONFIG
            console.log("Redirecting to onboarding with ID:", targetExpertId);
            window.location.href = `${CONFIG.URLS.onboarding}?expert_id=${encodeURIComponent(targetExpertId)}`;
        }


        // -- Gestion du retour d'Auth (Page Load) --
        async function finalizeIfAuthed(){
            if (inFlight) return;
            inFlight = true;
        
            try {
              const { data, error } = await supabase.auth.getSession();
              if (error) throw error;
        
              const user = data?.session?.user;
              if (!user) { inFlight = false; return; } // Pas connecté, on attend
        
              clearMsg();
              setGoogleLoading(true);
              setMagicLoading(true);
              showMsg("ok", lang === "fr" ? "Connexion réussie. Finalisation…" : "Signed in. Finalizing…");
        
              await ensureIntervenantRowAndRedirect(user);
            } catch (e) {
              console.error(e);
              setGoogleLoading(false);
              setMagicLoading(false);
              showMsg("error", (lang === "fr" ? "Erreur : " : "Error: ") + (e?.message || "unknown"));
              inFlight = false;
            }
        }

        // Écouteur Auth
        finalizeIfAuthed();
        supabase.auth.onAuthStateChange((event, session) => {
             if (event === 'SIGNED_IN') finalizeIfAuthed();
        });


        // -- Click Handlers --
        
        // Google
        googleBtn.addEventListener("click", async () => {
            clearMsg();
            setGoogleLoading(true);
            try {
              const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: { redirectTo: RETURN_URL }
              });
              if (error) throw error;
            } catch (e) {
              setGoogleLoading(false);
              showMsg("error", e.message);
            }
        });

        // Email Magic Link
        magicForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            clearMsg();
            const email = (document.getElementById("email").value || "").trim();
            if (!email) return;
        
            setMagicLoading(true);
            try {
              const { error } = await supabase.auth.signInWithOtp({
                email,
                options: { emailRedirectTo: RETURN_URL }
              });
              if (error) throw error;
              showMsg("ok", lang === "fr" ? "Lien envoyé !" : "Link sent!");
            } catch (e) {
              showMsg("error", e.message);
            } finally {
              setMagicLoading(false);
            }
        });
    }

});
