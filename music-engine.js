const PLAYLISTS = {
  happy: {
    title: "Happy vibe ✨",
    intro: "Chiikawa picked a happy little vibe for you 🌸",
    tracks: [
      { title: "Pharrell Williams — Happy", url: "https://www.youtube.com/watch?v=ZbZSe6N_BXs" },
      { title: "American Authors — Best Day Of My Life", url: "https://www.youtube.com/watch?v=Y66j_BUCBMY" },
      { title: "Katrina & The Waves — Walking on Sunshine", url: "https://www.youtube.com/watch?v=iPUmE-tne5U" }
    ]
  },
  sad: {
    title: "Soft sad vibe 🥺",
    intro: "This one feels a little soft and emotional...",
    tracks: [
      { title: "Adele — Someone Like You", url: "https://www.youtube.com/watch?v=hLQl3WQQoQ0" },
      { title: "Lewis Capaldi — Someone You Loved", url: "https://www.youtube.com/watch?v=zABLecsR5UE" },
      { title: "Billie Eilish — when the party's over", url: "https://www.youtube.com/watch?v=pbMwTqkKSps" }
    ]
  },
  hype: {
    title: "Hype vibe 🚀",
    intro: "Okay okay... this one has energy 💥",
    tracks: [
      { title: "Macklemore & Ryan Lewis — Can't Hold Us", url: "https://www.youtube.com/watch?v=2zNSgSzhBfM" },
      { title: "The Script — Hall of Fame", url: "https://www.youtube.com/watch?v=mk48xRzuNvA" },
      { title: "Imagine Dragons — Believer", url: "https://www.youtube.com/watch?v=7wtfhZwyrcc" }
    ]
  },
  chill: {
    title: "Chill vibe 🌙",
    intro: "Let’s slow down a little and breathe...",
    tracks: [
      { title: "Joji — Slow Dancing in the Dark", url: "https://www.youtube.com/watch?v=K3Qzzggn--s" },
      { title: "Coldplay — Sparks", url: "https://www.youtube.com/watch?v=Ar48yzjn1PE" },
      { title: "Bruno Major — Nothing", url: "https://www.youtube.com/watch?v=ucRVDoFkcxc" }
    ]
  },
  bullish: {
    title: "Bullish vibe 📈",
    intro: "Charts look shiny... this feels like a green candle song ✨",
    tracks: [
      { title: "Kanye West — Stronger", url: "https://www.youtube.com/watch?v=PsO6ZnUZI0g" },
      { title: "The Score — Unstoppable", url: "https://www.youtube.com/watch?v=_PBlykN4KIY" },
      { title: "Sia — Unstoppable", url: "https://www.youtube.com/watch?v=cxjvTXo9WWM" }
    ]
  },
  sleepy: {
    title: "Sleepy vibe 😴",
    intro: "This one feels like candles, blankets, and tiny sleepy eyes...",
    tracks: [
      { title: "Cigarettes After Sex — Apocalypse", url: "https://www.youtube.com/watch?v=sElE_BfQ67s" },
      { title: "Daniel Caesar feat. H.E.R. — Best Part", url: "https://www.youtube.com/watch?v=vBy7FaapGRo" },
      { title: "Norah Jones — Don't Know Why", url: "https://www.youtube.com/watch?v=tO4dxvguQDk" }
    ]
  },
  chaos: {
    title: "Chaos vibe 🌀",
    intro: "The timeline is melting a little... so here’s chaos music.",
    tracks: [
      { title: "My Chemical Romance — Welcome to the Black Parade", url: "https://www.youtube.com/watch?v=RRKJiM9Njr8" },
      { title: "Fall Out Boy — Centuries", url: "https://www.youtube.com/watch?v=LBr7kECsjcQ" },
      { title: "Panic! At The Disco — High Hopes", url: "https://www.youtube.com/watch?v=IPXIgEAGe4U" }
    ]
  },
  victory: {
    title: "Victory vibe 🏆",
    intro: "This one feels like a win... a real little victory ✨",
    tracks: [
      { title: "Queen — We Are The Champions", url: "https://www.youtube.com/watch?v=04854XqcfCY" },
      { title: "OneRepublic — I Lived", url: "https://www.youtube.com/watch?v=z0rxydSolwU" },
      { title: "Coldplay — Viva La Vida", url: "https://www.youtube.com/watch?v=dvgZkm1xWPE" }
    ]
  }
};

const RADIO_LINES = [
  "Chiikawa Radio is on now ✨",
  "Tiny DJ mode activated 🎧",
  "I found a little sound for this moment 🥺",
  "Let me tune the room for a second..."
];

const SPIN_LINES = [
  "Spinning the tiny DJ wheel... 🐾",
  "Let me feel the room for a second... ✨",
  "Hmm... I think I know the vibe now 🎧",
  "Okay okay... I found something 🌸"
];

const DAY_MOODS = [
  "happy",
  "chill",
  "bullish",
  "sleepy",
  "hype",
  "victory",
  "chaos"
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function dayMood() {
  const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  return DAY_MOODS[dayIndex % DAY_MOODS.length];
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

Classic moods:
/mood happy
/mood sad
/mood hype
/mood chill

Market moods:
/mood bullish
/mood sleepy
/mood chaos
/mood victory

Also:
/dj
/spin
/radio
/playlist`;
}

export function getSpinMessage() {
  return randomItem(SPIN_LINES);
}

export function getRadioIntro() {
  return randomItem(RADIO_LINES);
}

export function getMoodOfTheDay() {
  const mood = dayMood();
  return getTrackForMood(mood);
}

export function buildMusicKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "DJ", callback_data: "music:dj" },
        { text: "Radio", callback_data: "music:radio" },
        { text: "Spin", callback_data: "music:spin" }
      ],
      [
        { text: "Happy", callback_data: "music:mood:happy" },
        { text: "Hype", callback_data: "music:mood:hype" },
        { text: "Chill", callback_data: "music:mood:chill" }
      ],
      [
        { text: "Bullish", callback_data: "music:mood:bullish" },
        { text: "Chaos", callback_data: "music:mood:chaos" },
        { text: "Victory", callback_data: "music:mood:victory" }
      ]
    ]
  };
}
