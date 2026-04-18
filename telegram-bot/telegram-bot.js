bot.on("callback_query", async (query) => {
  const data = query?.data || "";
  const userId = query?.from?.id || 0;
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;

  console.log("CALLBACK HIT:", data, "chatId=", chatId, "messageId=", messageId);

  try {
    await bot.answerCallbackQuery(query.id);

    if (!chatId) {
      console.log("callback ignored: no chatId");
      return;
    }

    if (data === "ui:status") {
      await sendText(chatId, buildStatusText(userId));
      return;
    }

    if (data === "ui:l6") {
      await sendText(chatId, buildLevel6Text());
      return;
    }

    if (data === "ui:lang") {
      await sendText(chatId, t(userId, "chooseLang"), {
        reply_markup: buildLanguageKeyboard()
      });
      return;
    }

    if (data === "lang:en" || data === "lang:ru") {
      const lang = data.split(":")[1];
      setUserLang(userId, lang);

      await sendText(chatId, `${t(userId, "langSet")}: ${lang.toUpperCase()}`);

      if (messageId) {
        try {
          await bot.editMessageText(buildMainMenuText(userId), {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: buildMenuKeyboard()
          });
        } catch (e) {
          console.log("edit menu failed:", e.message);
          await openMenu(chatId, userId);
        }
      } else {
        await openMenu(chatId, userId);
      }

      return;
    }

    if (data === "cmd:test_trade") {
      await sendText(chatId, t(userId, "entryStarted"));

      const userSender = async (payload) => {
        await sendTradePayload(chatId, payload);
      };

      const groupSender = async (payload) => {
        await sendTradePayload(CHAT_ID, payload);
      };

      await simulateTradeFlow(userSender, groupSender);
      return;
    }

    if (data === "cmd:toggle_trading") {
      const runtime = getTradingRuntime();
      await handleTradingCommand(runtime.enabled ? "/trading_off" : "/trading_on");

      if (messageId) {
        try {
          await bot.editMessageText(buildMainMenuText(userId), {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: buildMenuKeyboard()
          });
        } catch (e) {
          console.log("edit after toggle trading failed:", e.message);
          await openMenu(chatId, userId);
        }
      } else {
        await openMenu(chatId, userId);
      }

      return;
    }

    if (data === "cmd:toggle_dryrun") {
      const runtime = getTradingRuntime();
      await handleTradingCommand(runtime.dryRun ? "/dryrun_off" : "/dryrun_on");

      if (messageId) {
        try {
          await bot.editMessageText(buildMainMenuText(userId), {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: buildMenuKeyboard()
          });
        } catch (e) {
          console.log("edit after toggle dryrun failed:", e.message);
          await openMenu(chatId, userId);
        }
      } else {
        await openMenu(chatId, userId);
      }

      return;
    }

    if (data === "cmd:mode") {
      await handleTradingCommand("/trade_mode");

      if (messageId) {
        try {
          await bot.editMessageText(buildMainMenuText(userId), {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: buildMenuKeyboard()
          });
        } catch (e) {
          console.log("edit after mode failed:", e.message);
          await openMenu(chatId, userId);
        }
      } else {
        await openMenu(chatId, userId);
      }

      return;
    }

    if (data === "cmd:kill") {
      await handleTradingCommand("/kill_switch");

      if (messageId) {
        try {
          await bot.editMessageText(buildMainMenuText(userId), {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: buildMenuKeyboard()
          });
        } catch (e) {
          console.log("edit after kill failed:", e.message);
          await openMenu(chatId, userId);
        }
      } else {
        await openMenu(chatId, userId);
      }

      return;
    }

    console.log("unknown callback:", data);
  } catch (error) {
    console.log("callback error full:", error);

    try {
      if (chatId) {
        await sendText(chatId, `⚠️ Callback error: ${error.message}`);
      }
    } catch {}
  }
});
