const installButton = document.getElementById('install');
const toggleButton = document.getElementById('toggle');
const statusText = document.getElementById('status');
const progress = document.getElementById('progress');

async function launchChrome() {
  const result = await window.hadex.toggleView();
  statusText.textContent = result.message || (result.ok ? 'Google Chrome اجرا شد.' : 'اجرای Chrome ناموفق بود.');
  if (!result.ok) console.error(result.message);
}

toggleButton.addEventListener('click', async () => {
  toggleButton.disabled = true;
  try {
    await launchChrome();
  } catch (error) {
    statusText.textContent = 'خطا: ' + error.message;
  } finally {
    toggleButton.disabled = false;
  }
});

installButton.addEventListener('click', async () => {
  installButton.disabled = true;
  progress.classList.add('active');
  statusText.textContent = 'در حال اجرای Google Chrome...';
  try {
    const result = await window.hadex.startInstall();
    statusText.textContent = result.message || 'پایان اجرا';
    if (!result.ok) console.error(result.message);
  } catch (error) {
    statusText.textContent = 'خطا: ' + error.message;
  } finally {
    installButton.disabled = false;
    progress.classList.remove('active');
  }
});
