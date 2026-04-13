const PLAYLISTS = {
  happy: {
    title: "Happy vibe ✨",
    intro: "Chiikawa picked a happy little vibe for you 🌸",
    tracks: [
      {
        title: "Happy song 1",
        url: "https://www.youtube.com/watch?v=ZbZSe6N_BXs"
      },
      {
        title: "Happy song 2",
        url: "https://www.youtube.com/watch?v=y6Sxv-sUYtM"
      },
      {
        title: "Happy song 3",
        url: "https://www.youtube.com/watch?v=ru0K8uYEZWw"
      }
    ]
  },
  sad: {
    title: "Soft sad vibe 🥺",
    intro: "This one feels a little soft and emotional...",
    tracks: [
      {
        title: "Sad song 1",
        url: "https://www.youtube.com/watch?v=hLQl3WQQoQ0"
      },
      {
        title: "Sad song 2",
        url: "https://www.youtube.com/watch?v=RgKAFK5djSk"
      },
      {
        title: "Sad song 3",
        url: "https://www.youtube.com/watch?v=lp-EO5I60KA"
      }
    ]
  },
  hype: {
    title: "Hype vibe 🚀",
    intro: "Okay okay... this one has energy 💥",
    tracks: [
      {
        title: "Hype song 1",
        url: "https://www.youtube.com/watch?v=09R8_2nJtjg"
      },
      {
        title: "Hype song 2",
        url: "https://www.youtube.com/watch?v=fLexgOxsZu0"
      },
      {
        title: "Hype song 3",
        url: "https://www.youtube.com/watch?v=JGwWNGJdvx8"
      }
    ]
  },
  chill: {
    title: "Chill vibe 🌙",
    intro: "Let’s slow down a little and breathe...",
    tracks: [
      {
        title: "Chill song 1",
        url: "https://www.youtube.com/watch?v=2Vv-BfVoq4g"
      },
      {
        title: "Chill song 2",
        url: "https://www.youtube.com/watch?v=kXYiU_JCYtU"
      },
      {
        title: "Chill song 3",
        url: "https://www.youtube.com/watch?v=JfGD75vHWrU"
      }
    ]
  }
};

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatTrackMessage(playlistKey, track) {
  const playlist = PLAYLISTS[playlistKey];
  return `${playlist.intro}

${playlist.title}

${track.title}
${track.url}`;
}

export function getAvailableMoods() {
  return Object.keys(PLAYLISTS);
}

export function isMoodSupported(mood) {
  return Boolean(PLAYLISTS[String(mood || "").toLowerCase()]);
}

export function getTrackForMood(mood) {
  const key = String(mood || "").toLowerCase();
  const playlist = PLAYLISTS[key];

  if (!playlist) return null;

  const track = randomItem(playlist.tracks);
  return {
    mood: key,
    title: playlist.title,
    message: formatTrackMessage(key, track),
    track
  };
}

export function getRandomDJTrack() {
  const moods = getAvailableMoods();
  const mood = randomItem(moods);
  return getTrackForMood(mood);
}

export function getPlaylistMessage() {
  return `Chiikawa playlists ✨

/mood happy
/mood sad
/mood hype
/mood chill

Or use:
/dj
/spin
/playlist`;
}

export function getSpinMessage() {
  const reactions = [
    "Spinning the tiny DJ wheel... 🐾",
    "Let me feel the room for a second... ✨",
    "Hmm... I think I know the vibe now 🎧",
    "Okay okay... I found something 🌸"
  ];

  return randomItem(reactions);
}
