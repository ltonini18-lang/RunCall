// Gestion simple des modales

document.addEventListener("DOMContentLoaded", () => {
  const openButtons = document.querySelectorAll("[data-modal-target]");
  const closeElements = document.querySelectorAll("[data-close-modal]");

  openButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-modal-target");
      const modal = document.querySelector(target);
      if (modal) {
        modal.classList.add("is-open");
      }
    });
  });

  closeElements.forEach((el) => {
    el.addEventListener("click", () => {
      const modal = el.closest(".modal");
      if (modal) {
        modal.classList.remove("is-open");
      }
    });
  });

  // Fermer avec ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document
        .querySelectorAll(".modal.is-open")
        .forEach((m) => m.classList.remove("is-open"));
    }
  });
});
