import {
  publicStrategyLabel,
  isRiskierPublicStrategy
} from "./public-group-policy.js";

function asText(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pctText(value) {
  const n = safeNum(value, 0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function shortCa(ca) {
  const s = asText(ca, "");
  if (!s) return "-";
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-6)}`;
}

function stableHash(input) {
  const s = asText(input, "seed");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function pickStable(seed, rows = []) {
  if (!rows.length) return "";
  return rows[stableHash(seed) % rows.length];
}

function titleFromToken(tokenLike = {}) {
  const symbol = asText(tokenLike?.symbol, "");
  const name = asText(tokenLike?.name, "");
  if (symbol && name && symbol.toLowerCase() !== name.toLowerCase()) {
    return `$${symbol} · ${name}`;
  }
  if (symbol) return `$${symbol}`;
  if (name) return name;
  return shortCa(tokenLike?.ca);
}

function rawName(tokenLike = {}) {
  return asText(tokenLike?.symbol || tokenLike?.name || shortCa(tokenLike?.ca), "token");
}

function dexLink(tokenLike = {}) {
  return asText(tokenLike?.url, "");
}

function strategyMoodLine(strategy, seed) {
  const key = String(strategy || "");
  const rows = {
    reversal: [
      "Похоже, тут рынок пытается развернуться без лишней драмы.",
      "Тут мне нравится, как цена встала на ноги после нервного участка.",
      "Есть ощущение, что это не случайный отскок, а попытка собраться."
    ],
    runner: [
      "Этот зверь выглядит так, будто еще не сказал последнее слово.",
      "Пока это похоже на бегуна, который только нашел удобный темп.",
      "Есть шанс, что движение тут не закончилось на первой красивой свече."
    ],
    migration_survivor: [
      "После миграции выглядит живым, а это уже редкость, за которую я уважаю.",
      "Не рассыпался после переезда и держится бодро — люблю такие истории.",
      "Пережил самую нервную часть и пока не выглядит как одноразовый фокус."
    ],
    copytrade: [
      "Сигнал тут рискованнее обычного, поэтому захожу аккуратнее и меньшим размером.",
      "Идея интересная, но тут я держу голову прохладной и позицию скромной.",
      "Здесь я скорее наблюдаю и пробую, чем женюсь на позиции."
    ]
  };

  return pickStable(`${seed}:${key}:mood`, rows[key] || rows.reversal);
}

function memeJoke(tokenLike, seed) {
  const name = rawName(tokenLike);

  const rows = [
    `${name} звучит так, будто кто-то придумал мем в 3 ночи. Обычно это плохой знак. Иногда — отличный.`,
    `У ${name} настроение как у монеты, которая уже нашла свой маленький фан-клуб.`,
    `${name} выглядит так, будто мемы снова решили спорить с рациональностью.`,
    `График у ${name} пока говорит громче, чем его название, а это мне обычно нравится.`,
    `Похоже, ${name} сегодня проснулся раньше рынка и уже что-то задумал.`,
    `Будто мой старый знакомый Пепе шепнул: “присмотрись, но без безумств”.`,
    `Иногда рынок подмигивает странно. Сегодня это делает ${name}.`,
    `Не знаю, кто выпустил ${name} на график, но скучно тут пока не выглядит.`
  ];

  return pickStable(`${seed}:${name}:joke`, rows);
}

function riskLine(strategy, seed) {
  const risky = isRiskierPublicStrategy(strategy);

  const common = [
    "В крипте повороты резкие, так что размер позиции лучше держать умеренным.",
    "Даже симпатичная идея не повод залетать большим объемом.",
    "Лично я бы не грузил на одну идею больше 5–10% депозита.",
    "Крипта любит сюрпризы, поэтому без перегруза по размеру позиции.",
    "Красивый график — еще не приглашение к олл-ину."
  ];

  const riskyOnly = [
    "Это более рискованная идея, так что здесь особенно не стоит завышать размер позиции.",
    "Тут осторожность важнее эмоций: маленький размер и холодная голова.",
    "Сигнал интересный, но это именно тот случай, где скромный размер позиции полезнее смелости."
  ];

  const pool = risky ? [...riskyOnly, ...common] : common;
  return pickStable(`${seed}:${strategy}:risk`, pool);
}

function shouldShowRisk(seed) {
  return stableHash(`${seed}:risk:show`) % 100 < 52;
}

function entryHeader(strategy, seed) {
  const risky = isRiskierPublicStrategy(strategy);
  if (risky) {
    return pickStable(`${seed}:entry:risky`, [
      "⚠️ <b>CHIIKAWA IDEA</b>",
      "🟠 <b>CHIIKAWA WATCHING THIS ONE</b>",
      "👀 <b>CHIIKAWA RISKY NOTE</b>"
    ]);
  }

  return pickStable(`${seed}:entry:normal`, [
    "🚀 <b>CHIIKAWA IDEA</b>",
    "✨ <b>CHIIKAWA FOUND ONE</b>",
    "🐾 <b>CHIIKAWA MOVE</b>",
    "🍃 <b>CHIIKAWA APED A LITTLE</b>"
  ]);
}

function exitHeader(outcome, seed) {
  if (outcome === "win") {
    return pickStable(`${seed}:exit:win`, [
      "✅ <b>CHIIKAWA RESULT</b>",
      "🏁 <b>CHIIKAWA CLOSED GREEN</b>",
      "🌿 <b>CHIIKAWA TOOK THE MOVE</b>"
    ]);
  }

  if (outcome === "flat") {
    return pickStable(`${seed}:exit:flat`, [
      "⚪ <b>CHIIKAWA RESULT</b>",
      "🤍 <b>CHIIKAWA CLOSED FLAT</b>",
      "🫧 <b>CHIIKAWA STEP BACK</b>"
    ]);
  }

  return pickStable(`${seed}:exit:loss`, [
    "🔻 <b>CHIIKAWA RESULT</b>",
    "🧯 <b>CHIIKAWA CUT THE RISK</b>",
    "🌧 <b>CHIIKAWA CLOSED RED</b>"
  ]);
}

function exitComment(outcome, tokenLike, strategy, seed) {
  const name = rawName(tokenLike);

  const byOutcome = {
    win: [
      `${name} дал движение, и я не стал спорить с хорошим результатом.`,
      `Иногда мемы ведут себя прилично. ${name} сегодня как раз из таких.`,
      `Забрал движение и пошел дальше. Жадность пусть сегодня отдыхает.`,
      `Хорошая прогулка. Не каждая идея обязана становиться сагой.`
    ],
    flat: [
      `${name} не раскрылся как хотелось, так что вышел спокойно и без лишнего упрямства.`,
      `Когда идея не спешит цвести, лучше не держать ее за рукав.`,
      `Иногда лучший результат — это вовремя не усложнять.`,
      `Ничего драматичного: посмотрел, посидел, вышел без лишнего шума.`
    ],
    loss: [
      `${name} решил пойти другим путем, а я решил не спорить с риском.`,
      `Не каждая затея обязана выстрелить. Зато дисциплина снова дома.`,
      `Мемы любят шутки, но риск-менеджмент у меня все еще без чувства юмора.`,
      `План не подтвердился, так что просто закрыл и поехали дальше.`
    ]
  };

  const strategyTail = {
    reversal: [
      "Развороты иногда требуют терпения, а иногда — уважения к стопу.",
      "С разворотами главное не путать надежду с подтверждением."
    ],
    runner: [
      "У бегунов свой характер: или бегут, или лучше отпустить.",
      "Такие истории хороши ровно до тех пор, пока движение живое."
    ],
    migration_survivor: [
      "После миграции выживают не все, поэтому к таким историям я отношусь внимательно.",
      "Переезд пережил — уже молодец. Но рынок все равно любит проверять на прочность."
    ],
    copytrade: [
      "Более рискованные идеи я всегда держу покороче и холоднее.",
      "Это был как раз тот случай, где осторожность важнее красивой легенды."
    ]
  };

  const part1 = pickStable(`${seed}:${outcome}:main`, byOutcome[outcome] || byOutcome.flat);
  const part2 = pickStable(`${seed}:${strategy}:tail`, strategyTail[strategy] || strategyTail.reversal);

  return `${part1}\n${part2}`;
}

function outcomeFromPnl(pnlPct) {
  const n = safeNum(pnlPct, 0);
  if (n > 0.35) return "win";
  if (n < -0.35) return "loss";
  return "flat";
}

export default class GroupMessageFormatter {
  buildEntryPost(position) {
    const token = position?.signalContext?.token || position?.token || {};
    const mergedToken = {
      name: position?.token || token?.name || "",
      symbol: position?.symbol || token?.symbol || "",
      ca: position?.ca || token?.ca || "",
      url: token?.url || position?.signalContext?.url || "",
      imageUrl: position?.signalContext?.imageUrl || token?.imageUrl || null
    };

    const seed = `${mergedToken.ca || mergedToken.symbol || "token"}:entry:${position?.strategy || ""}`;
    const title = titleFromToken(mergedToken);
    const dex = dexLink(mergedToken);
    const ca = asText(mergedToken.ca, "-");
    const ideaType = publicStrategyLabel(position?.strategy);

    const lines = [
      entryHeader(position?.strategy, seed),
      "",
      `<b>${escapeHtml(title)}</b>`,
      `Идея: ${escapeHtml(ideaType)}`,
      "",
      escapeHtml(strategyMoodLine(position?.strategy, seed)),
      escapeHtml(memeJoke(mergedToken, seed)),
      "",
      dex ? `🔗 <a href="${escapeHtml(dex)}">DexScreener</a>` : "",
      `CA: <code>${escapeHtml(ca)}</code>`
    ].filter(Boolean);

    if (shouldShowRisk(seed)) {
      lines.push("");
      lines.push(`🫶 ${escapeHtml(riskLine(position?.strategy, seed))}`);
    }

    return lines.join("\n");
  }

  buildExitPost(closedTrade) {
    const token = {
      name: closedTrade?.token || "",
      symbol: closedTrade?.symbol || "",
      ca: closedTrade?.ca || "",
      url: closedTrade?.signalContext?.token?.url || closedTrade?.signalContext?.url || "",
      imageUrl: closedTrade?.signalContext?.imageUrl || null
    };

    const seed = `${token.ca || token.symbol || "token"}:exit:${closedTrade?.strategy || ""}:${closedTrade?.reason || ""}`;
    const title = titleFromToken(token);
    const outcome = outcomeFromPnl(closedTrade?.netPnlPct);
    const dex = dexLink(token);
    const ca = asText(token.ca, "-");

    const lines = [
      exitHeader(outcome, seed),
      "",
      `<b>${escapeHtml(title)}</b>`,
      `Result: <b>${escapeHtml(pctText(closedTrade?.netPnlPct))}</b>`,
      "",
      escapeHtml(exitComment(outcome, token, closedTrade?.strategy, seed)),
      "",
      dex ? `🔗 <a href="${escapeHtml(dex)}">DexScreener</a>` : "",
      `CA: <code>${escapeHtml(ca)}</code>`
    ].filter(Boolean);

    if (shouldShowRisk(`${seed}:exit:risk`)) {
      lines.push("");
      lines.push(`🫶 ${escapeHtml(riskLine(closedTrade?.strategy, seed))}`);
    }

    return lines.join("\n");
  }
}
