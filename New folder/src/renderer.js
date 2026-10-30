const installButton = document.getElementById('install');
const toggleButton = document.getElementById('toggle');
const statusText = document.getElementById('status');
const progress = document.getElementById('progress');

toggleButton.addEventListener('click', async () => {
  const switched = await window.hadex.toggleView();
  if (switched) toggleButton.textContent =
    toggleButton.textContent === 'نمایش Chromium' ? 'بازگشت به نصب' : 'نمایش Chromium';
});
installButton.addEventListener('click', async () => {
  installButton.disabled = true;
  progress.classList.add('active');
  statusText.textContent = 'در حال اجرای مرحله نصب...';
  try {
    const result = await window.hadex.startInstall();
    statusText.textContent = result.message || 'پایان اجرا';
    if (!result.ok) console.error(result.output || result.message);
  } catch (error) { statusText.textContent = 'خطا: ' + error.message; }
  finally { installButton.disabled = false; progress.classList.remove('active'); }
});
