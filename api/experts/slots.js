// Test minimal pour api/experts/slots.js
module.exports = (req, res) => {
    // On autorise tout le monde (CORS) pour ne pas être bloqué par le navigateur
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    
    // Réponse immédiate
    res.status(200).json({ 
        message: "Slots API reached!", 
        query: req.query 
    });
};
