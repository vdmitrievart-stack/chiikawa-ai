export function buildYouTubeAnnouncement(input = {}) {
  const title = String(input.title || "New YouTube episode");
  const url = String(input.url || "");
  const moodLine = String(input.moodLine || "");

  return `📺 NEW CHIIKAWA EPISODE!

${title}

${moodLine}

${url}`.trim();
}

export default {
  buildYouTubeAnnouncement
};
