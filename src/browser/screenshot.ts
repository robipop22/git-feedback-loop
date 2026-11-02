export const readFeedbackScreenshot = async (file: File): Promise<string> => {
  if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 2_000_000) throw new Error("Use a PNG or JPEG image smaller than 2 MB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file);
  });
};

export const captureFeedbackScreenshot = async (): Promise<string> => {
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement("video"); video.srcObject = stream; video.muted = true;
    await video.play();
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1440 / video.videoWidth);
    canvas.width = video.videoWidth * scale; canvas.height = video.videoHeight * scale;
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.8);
    if (data.length > 2_660_000) throw new Error("The screenshot exceeds 2 MB.");
    return data;
  } finally { stream?.getTracks().forEach((track) => track.stop()); }
};
