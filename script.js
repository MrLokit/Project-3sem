"use strict";

const API_URL = "http://127.0.0.1:8000/api/analyze_voice";
const MAX_RECOGNITION_RESTARTS = 30;
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

// Поддерживаем и сокращённые метки модели, и полные названия от сервера.
const EMOTION_LABELS = {
  neu: "neutral",
  hap: "happy",
  ang: "angry",
  anger: "angry",
  sad: "sad",
};

const SpeechRecognitionAPI =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const micButton = document.getElementById("micButton");
const voiceControl = document.getElementById("voiceControl");
const voiceStatus = document.getElementById("voiceStatus");
const chat = document.getElementById("chat");
const chatEmpty = document.getElementById("chatEmpty");
const appHint = document.querySelector(".app__hint");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let isStarting = false;
let isRecording = false;
let isProcessing = false;

let recognition = null;
let recognitionActive = false;
let recognitionStopping = false;
let recognitionEndPromise = null;
let resolveRecognitionEnd = null;
let recognitionWanted = false;
let recognitionFatalError = false;
let recognitionRestartTimer = null;
let recognitionRestartCount = 0;
let finalTranscript = "";
let interimTranscript = "";
let transcriptAtStop = "";

function setStatus(text) {
  voiceStatus.textContent = text;
}

function setRecordingUI(recording) {
  isRecording = recording;
  voiceControl.classList.toggle("is-listening", recording);
  micButton.setAttribute("aria-pressed", String(recording));
  micButton.setAttribute(
    "aria-label",
    recording ? "Остановить запись" : "Начать запись"
  );
}

function setBusy(busy) {
  isProcessing = busy;
  micButton.disabled = busy;

  if (busy) {
    setStatus("Анализирую эмоцию…");
  }
}

function scrollChatToBottom() {
  window.requestAnimationFrame(() => {
    chat.scrollTo({
      top: chat.scrollHeight,
      behavior: reducedMotion.matches ? "auto" : "smooth",
    });
  });
}

function hideEmptyState() {
  chatEmpty.hidden = true;
}

function addMessage(role, text, { isError = false } = {}) {
  hideEmptyState();

  const row = document.createElement("div");
  row.className = `message message--${role}${isError ? " message--error" : ""}`;

  const author = document.createElement("span");
  author.className = "message__author";
  author.textContent = role === "user" ? "Вы" : "Ассистент";

  const bubble = document.createElement("div");
  bubble.className = "message__bubble";
  bubble.textContent = text;

  row.append(author, bubble);
  chat.append(row);
  scrollChatToBottom();

  return row;
}

function showTypingIndicator() {
  hideEmptyState();

  const row = document.createElement("div");
  row.className = "message message--assistant";

  const author = document.createElement("span");
  author.className = "message__author";
  author.textContent = "Ассистент";

  const bubble = document.createElement("div");
  bubble.className = "message__bubble typing";
  bubble.setAttribute("aria-label", "Анализирую эмоцию");

  for (let i = 0; i < 3; i += 1) {
    bubble.append(document.createElement("span"));
  }

  row.append(author, bubble);
  chat.append(row);
  scrollChatToBottom();

  return row;
}

function speak(text) {
  if (
    !("speechSynthesis" in window) ||
    !("SpeechSynthesisUtterance" in window) ||
    !text
  ) {
    return;
  }

  const synthesis = window.speechSynthesis;
  synthesis.cancel();

  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = 1.02;
    utterance.pitch = 1;

    const voices = synthesis.getVoices();
    const russianVoice =
      voices.find(
        (voice) => voice.lang.toLowerCase().replace("_", "-") === "ru-ru"
      ) || voices.find((voice) => voice.lang.toLowerCase().startsWith("ru"));

    if (russianVoice) {
      utterance.voice = russianVoice;
    }

    synthesis.speak(utterance);
  } catch (error) {
    // Озвучивание не должно ломать уже полученный ответ ассистента.
    console.warn("Не удалось озвучить ответ:", error);
  }
}

function resetSpeechRecognitionState() {
  finalTranscript = "";
  interimTranscript = "";
  transcriptAtStop = "";
  recognitionRestartCount = 0;
}

function getRecognizedText() {
  return `${finalTranscript} ${interimTranscript}`
    .replace(/\s+/g, " ")
    .trim();
}

function snapshotRecognizedText() {
  transcriptAtStop = getRecognizedText();
  return transcriptAtStop;
}

function resolveRecognitionEndPromise() {
  if (resolveRecognitionEnd) {
    resolveRecognitionEnd();
    resolveRecognitionEnd = null;
  }

  recognitionEndPromise = null;
}

function scheduleRecognitionRestart() {
  if (
    !recognitionWanted ||
    !isRecording ||
    recognitionFatalError ||
    recognitionRestartTimer
  ) {
    return;
  }

  if (recognitionRestartCount >= MAX_RECOGNITION_RESTARTS) {
    console.warn("Распознавание речи остановлено: слишком много перезапусков");
    return;
  }

  recognitionRestartCount += 1;
  recognitionRestartTimer = window.setTimeout(() => {
    recognitionRestartTimer = null;
    startRecognitionSession();
  }, 250);
}

function startRecognitionSession() {
  if (!recognition || !recognitionWanted) {
    return;
  }

  try {
    recognition.start();
    recognitionActive = true;
    recognitionStopping = false;
    recognitionEndPromise = new Promise((resolve) => {
      resolveRecognitionEnd = resolve;
    });
  } catch (error) {
    recognitionActive = false;
    console.warn("Не удалось запустить распознавание речи:", error);
    scheduleRecognitionRestart();
  }
}

function setupSpeechRecognition() {
  if (!SpeechRecognitionAPI) {
    return;
  }

  recognition = new SpeechRecognitionAPI();
  recognition.lang = "ru-RU";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.addEventListener("result", (event) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? "";

      if (result.isFinal) {
        finalTranscript = `${finalTranscript} ${transcript}`
          .replace(/\s+/g, " ")
          .trim();
      } else {
        interim += transcript;
      }
    }

    interimTranscript = interim.replace(/\s+/g, " ").trim();
    recognitionRestartCount = 0;
  });

  recognition.addEventListener("error", (event) => {
    const errorCode = event.error || "unknown";

    // При этих ошибках перезапуск не поможет — микрофон или сервис
    // распознавания недоступны.
    if (
      errorCode === "not-allowed" ||
      errorCode === "service-not-allowed" ||
      errorCode === "audio-capture"
    ) {
      recognitionFatalError = true;
    }

    if (errorCode !== "aborted" && errorCode !== "no-speech") {
      console.warn("Ошибка распознавания речи:", errorCode);
    }
  });

  recognition.addEventListener("end", () => {
    recognitionActive = false;
    recognitionStopping = false;

    // Если сессия распознавания завершилась, не потеряем последний
    // промежуточный результат: переносим его в финальный текст.
    if (interimTranscript) {
      finalTranscript = `${finalTranscript} ${interimTranscript}`
        .replace(/\s+/g, " ")
        .trim();
      interimTranscript = "";
    }

    resolveRecognitionEndPromise();

    // Chrome завершает распознавание после паузы или ошибки no-speech.
    // Пока идёт запись, запускаем его снова, чтобы не потерять речь.
    if (recognitionWanted && isRecording) {
      scheduleRecognitionRestart();
    }
  });
}

function startSpeechRecognition() {
  resetSpeechRecognitionState();
  recognitionFatalError = false;

  if (!recognition) {
    recognitionWanted = false;
    return;
  }

  recognitionWanted = true;
  startRecognitionSession();
}

function stopSpeechRecognition() {
  recognitionWanted = false;

  if (recognitionRestartTimer) {
    window.clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = null;
  }

  if (!recognition || !recognitionActive || recognitionStopping) {
    return;
  }

  recognitionStopping = true;

  try {
    recognition.stop();
  } catch (error) {
    recognitionActive = false;
    recognitionStopping = false;
    resolveRecognitionEndPromise();
    console.warn("Не удалось остановить распознавание речи:", error);
  }
}

function waitForSpeechRecognition(timeoutMs = 3000) {
  if (!recognitionEndPromise) {
    return Promise.resolve();
  }

  return Promise.race([
    recognitionEndPromise,
    new Promise((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
}

function getSupportedMimeType() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function getMicrophoneErrorMessage(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Доступ к микрофону запрещён. Разрешите его в настройках браузера";
    case "NotFoundError":
      return "Микрофон не найден";
    case "NotReadableError":
      return "Микрофон занят другим приложением";
    default:
      return "Не удалось получить доступ к микрофону";
  }
}

function stopMediaStream() {
  if (!mediaStream) {
    return;
  }

  mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function encodeWav(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const mono = new Float32Array(frameCount);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const channelData = audioBuffer.getChannelData(channel);

    for (let i = 0; i < frameCount; i += 1) {
      mono[i] += channelData[i] / channelCount;
    }
  }

  const bytesPerSample = 2;
  const dataSize = frameCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(
      offset,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true
    );
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function convertToWav(blob) {
  if (!AudioContextClass) {
    throw new Error("Web Audio API недоступен");
  }

  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContextClass();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

    if (!audioBuffer.length) {
      throw new Error("Запись не содержит аудио");
    }

    return encodeWav(audioBuffer);
  } finally {
    await audioContext.close();
  }
}

async function startRecording() {
  if (isStarting || isRecording || isProcessing) {
    return;
  }

  isStarting = true;
  micButton.disabled = true;
  setStatus("Запрашиваю доступ к микрофону…");

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const mimeType = getSupportedMimeType();
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);

    audioChunks = [];

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", () => {
      void handleRecordingStopped();
    });

    mediaRecorder.addEventListener("error", (event) => {
      console.error("Ошибка MediaRecorder:", event.error || event);
      setStatus("Не удалось записать аудио. Попробуйте ещё раз");
    });

    mediaStream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
          setStatus("Микрофон отключился");
          mediaRecorder.stop();
        }
      });
    });

    mediaRecorder.start();
    startSpeechRecognition();
    setRecordingUI(true);
    setStatus(
      recognition
        ? "Идёт запись и распознавание речи… Нажмите на микрофон, чтобы остановить"
        : "Идёт запись… Нажмите на микрофон, чтобы остановить"
    );
  } catch (error) {
    console.error("Не удалось начать запись:", error);
    stopMediaStream();
    setRecordingUI(false);
    mediaRecorder = null;
    setStatus(getMicrophoneErrorMessage(error));
    micButton.disabled = false;
  } finally {
    isStarting = false;

    if (isRecording) {
      micButton.disabled = false;
    }
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return;
  }

  setRecordingUI(false);
  setStatus("Завершаю запись и распознавание речи…");
  isProcessing = true;
  micButton.disabled = true;

  // Фиксируем уже распознанное: финальный результат может прийти
  // уже после остановки распознавания.
  snapshotRecognizedText();

  try {
    stopSpeechRecognition();
    mediaRecorder.stop();
  } catch (error) {
    console.error("Не удалось остановить запись:", error);
    stopSpeechRecognition();
    stopMediaStream();
    mediaRecorder = null;
    audioChunks = [];
    setBusy(false);
    setStatus("Не удалось остановить запись. Попробуйте ещё раз");
  }
}

async function handleRecordingStopped() {
  setRecordingUI(false);
  stopSpeechRecognition();
  await waitForSpeechRecognition();
  stopMediaStream();

  const recognizedText = getRecognizedText() || transcriptAtStop;
  console.info(
    "Распознанный текст:",
    recognizedText ? `«${recognizedText}»` : "(пусто)"
  );
  const mimeType =
    mediaRecorder?.mimeType || audioChunks[0]?.type || "audio/webm";
  const recordedBlob = new Blob(audioChunks, { type: mimeType });

  mediaRecorder = null;
  audioChunks = [];

  if (recordedBlob.size === 0) {
    setBusy(false);
    setStatus("Запись получилась пустой. Попробуйте ещё раз");
    return;
  }

  setBusy(true);
  addMessage("user", recognizedText || "Голосовое сообщение");
  const typingIndicator = showTypingIndicator();

  try {
    let wavBlob;

    try {
      wavBlob = await convertToWav(recordedBlob);
    } catch (error) {
      console.error("Не удалось преобразовать запись в WAV:", error);
      typingIndicator.remove();
      addMessage("assistant", "Не удалось обработать запись", {
        isError: true,
      });
      setStatus("Попробуйте записать голос ещё раз");
      return;
    }

    const formData = new FormData();
    formData.append("file", wavBlob, "voice.wav");
    formData.append("text", recognizedText);

    const response = await fetch(API_URL, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Сервер вернул статус ${response.status}`);
    }

    const data = await response.json();
    const emotion = typeof data.emotion === "string" ? data.emotion.trim() : "";
    const score = Number(data.score);
    const answer = typeof data.answer === "string" ? data.answer.trim() : "";

    if (!emotion || !Number.isFinite(score)) {
      throw new Error("Сервер вернул некорректный ответ");
    }

    const formattedScore = Number(score.toFixed(4));
    const emotionLabel = EMOTION_LABELS[emotion.toLowerCase()] || emotion;
    const emotionMessage =
      `Я слышу, что ты испытываешь эмоцию: ${emotionLabel}. ` +
      `Уверенность: ${formattedScore}`;

    typingIndicator.remove();
    addMessage("assistant", emotionMessage);

    if (answer) {
      addMessage("assistant", answer);
      speak(answer);
    }

    setStatus("Нажмите на микрофон, чтобы записать ещё раз");
  } catch (error) {
    console.error("Не удалось распознать эмоцию:", error);
    typingIndicator.remove();
    addMessage("assistant", "Ошибка сервера", { isError: true });
    setStatus("Не удалось распознать эмоцию. Попробуйте ещё раз");
  } finally {
    typingIndicator.remove();
    setBusy(false);
  }
}

const canRecord = Boolean(
  navigator.mediaDevices?.getUserMedia &&
    window.MediaRecorder &&
    AudioContextClass
);

setupSpeechRecognition();

if ("speechSynthesis" in window) {
  // Некоторые браузеры загружают список голосов асинхронно.
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    window.speechSynthesis.getVoices();
  });
}

if (!canRecord) {
  micButton.disabled = true;
  micButton.setAttribute("aria-label", "Запись с микрофона недоступна");
  setStatus("Запись с микрофона не поддерживается этим браузером");

  if (appHint) {
    appHint.textContent =
      "Откройте страницу через localhost в Chrome или Edge, чтобы записывать голос.";
  }
} else {
  micButton.addEventListener("click", () => {
    if (isStarting) {
      return;
    }

    if (isRecording) {
      stopRecording();
      return;
    }

    if (!isProcessing) {
      void startRecording();
    }
  });
}
