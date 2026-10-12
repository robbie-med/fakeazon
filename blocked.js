document.getElementById('back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = 'https://www.amazon.com/';
});
