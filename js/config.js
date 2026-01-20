// js/config.js

const CONFIG = {
    // Détection automatique de l'environnement
    ENV: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
        ? 'local' 
        : 'production',

    // URLs de base
    API_BASE_URL: '/api', // Sur Vercel, l'API est toujours relative
    
    // Définition des URLs du Frontend
    URLS: {
        dashboard: '/dashboard.html',
        login: '/login.html',
        onboarding: '/onboarding.html', // Ex devenir-intervenant-v2
        profile: '/profile.html',       // Ex intervenant.html
        support: '/support.html',
        success: '/success.html'
    }
};

// Fonction utilitaire pour récupérer les paramètres d'URL (ex: ?expert_id=...)
function getQueryParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
}

console.log(`RunCall Environment: ${CONFIG.ENV}`);
