export function buildYouTubeAnnouncement(input = {}) {
  const title = String(input.title || "New episode");
  const url = String(input.url || "");
  return `📺 New YouTube episode detected!\n\n${title}\n\n${url}`;
}

export function buildYouTubeComment(input = {}) {
  const title = String(input.title || "New episode");
  return `Chiikawa found a new episode 🐹✨\n\n${title}`;
}

export default {
  buildYouTubeAnnouncement,
  buildYouTubeComment
};
