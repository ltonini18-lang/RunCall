// Détection automatique de la langue (FR ou EN)
document.addEventListener("DOMContentLoaded", () => {
  const userLang = navigator.language || navigator.userLanguage;
  const isFrench = userLang.startsWith("fr");

  // Pour tous les éléments contenant data-fr et data-en
  document.querySelectorAll("[data-fr]").forEach(el => {
    el.textContent = isFrench ? el.dataset.fr : el.dataset.en;
  });
});
