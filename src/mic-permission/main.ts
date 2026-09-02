export {};

const statusEl = document.getElementById("status");

try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  if (statusEl) {
    statusEl.textContent = "Microphone access granted — you can close this tab.";
    statusEl.style.color = "#1a7f37";
  }
} catch (error) {
  if (statusEl) {
    statusEl.textContent = `Permission denied: ${String(error)}`;
    statusEl.style.color = "#b3261e";
  }
}
