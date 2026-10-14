// ==========================================================================
// Логика и интерактивность страницы (JavaScript)
// ==========================================================================

// 1. Находим элементы на странице по их ID
const actionBtn = document.getElementById('action-btn');
const extraInfo = document.getElementById('extra-info');

// 2. Добавляем слушатель события клика на кнопку
actionBtn.addEventListener('click', () => {
  // Проверяем, скрыт ли блок в данный момент
  const isHidden = extraInfo.classList.contains('hidden');

  if (isHidden) {
    // Показываем блок, убирая класс 'hidden'
    extraInfo.classList.remove('hidden');
    actionBtn.innerHTML = '<span>Скрыть ✕</span>';
  } else {
    // Скрываем блок, добавляя класс 'hidden'
    extraInfo.classList.add('hidden');
    actionBtn.innerHTML = '<span>Узнать больше ✨</span>';
  }
});
