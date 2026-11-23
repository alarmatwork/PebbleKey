#include <pebble.h>

// Commands sent to the phone (src/pkjs/index.js mirrors these).
#define CMD_UNLOCK 1
#define CMD_LOCK 2
#define CMD_CLIMATE 4  // phone starts or stops climate, whichever applies
#define CMD_UNLOCK_ANYWAY 5  // unlock without the distance check, after the user confirmed

// Status values received from the phone.
#define STATUS_PROGRESS 0
#define STATUS_OK 1
#define STATUS_ERROR 2
#define STATUS_CONFIRM 3  // phone is not near the car; ask for a second hold to unlock

#define HOLD_MS 700
#define REPLY_TIMEOUT_MS 75000
// How long a "hold UP again" confirmation stays open.
#define CONFIRM_MS 15000
// A hold only counts if the button went down this long after the app appeared. A button still
// held from launching the app (quick launch, or the app menu) would fire sooner than that.
#define FRESH_PRESS_MS 150

#define HINT_DEFAULT "Hold UP: unlock\nHold MID: climate\nHold DOWN: lock"
#define HINT_CONFIRM "Hold UP again\nto unlock anyway"

static Window *s_window;
static TextLayer *s_title_layer;
static TextLayer *s_info_layer;
static TextLayer *s_status_layer;
static TextLayer *s_hint_layer;

static char s_status_text[48] = "Ready";
static GColor s_status_color;
// What the car last reported, e.g. "Locked, 78%". Empty until the phone has fetched it.
static char s_info_text[32];
static bool s_js_ready;
static bool s_busy;
static int s_pending_cmd;
static bool s_confirming;
static uint32_t s_appeared_at_ms;
static AppTimer *s_timeout_timer;
static AppTimer *s_confirm_timer;

static void set_status(const char *text, GColor color) {
  strncpy(s_status_text, text, sizeof(s_status_text) - 1);
  s_status_text[sizeof(s_status_text) - 1] = '\0';
  s_status_color = PBL_IF_COLOR_ELSE(color, GColorWhite);
  // May run before the window has loaded; window_load applies it then.
  if (s_status_layer) {
    text_layer_set_text(s_status_layer, s_status_text);
    text_layer_set_text_color(s_status_layer, s_status_color);
  }
}

static void cancel_timer(AppTimer **timer) {
  if (*timer) {
    app_timer_cancel(*timer);
    *timer = NULL;
  }
}

static uint32_t now_ms(void) {
  time_t seconds;
  uint16_t ms;
  time_ms(&seconds, &ms);
  return (uint32_t)seconds * 1000 + ms;
}

static void set_confirming(bool confirming) {
  s_confirming = confirming;
  cancel_timer(&s_confirm_timer);
  if (s_hint_layer) {
    text_layer_set_text(s_hint_layer, confirming ? HINT_CONFIRM : HINT_DEFAULT);
  }
}

static void confirm_timer_cb(void *context) {
  s_confirm_timer = NULL;
  set_confirming(false);
  set_status("Ready", GColorWhite);
}

static void finish(bool ok, const char *text) {
  cancel_timer(&s_timeout_timer);
  s_busy = false;
  s_pending_cmd = 0;
  set_status(text, ok ? GColorGreen : GColorOrange);
  if (ok) {
    vibes_short_pulse();
  } else {
    vibes_double_pulse();
  }
}

// The phone found it is not near the car: show why and wait for a second hold of UP.
static void ask_confirmation(const char *text) {
  finish(false, text);
  set_confirming(true);
  s_confirm_timer = app_timer_register(CONFIRM_MS, confirm_timer_cb, NULL);
}

static void timeout_timer_cb(void *context) {
  s_timeout_timer = NULL;
  finish(false, "No reply from phone");
}

static void send_command(int cmd) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    finish(false, "Phone busy, retry");
    return;
  }
  dict_write_int32(iter, MESSAGE_KEY_Command, cmd);
  if (app_message_outbox_send() != APP_MSG_OK) {
    finish(false, "Phone not reachable");
  }
}

static void request(int cmd) {
  if (s_busy) {
    return;
  }
  set_confirming(false);
  s_busy = true;
  vibes_short_pulse();
  set_status(cmd == CMD_LOCK ? "Locking..." : cmd == CMD_CLIMATE ? "Climate..." : "Unlocking...",
             GColorWhite);
  cancel_timer(&s_timeout_timer);
  s_timeout_timer = app_timer_register(REPLY_TIMEOUT_MS, timeout_timer_cb, NULL);
  if (s_js_ready) {
    send_command(cmd);
  } else {
    // The phone-side JS is still starting; send as soon as it reports ready.
    s_pending_cmd = cmd;
  }
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  if (dict_find(iter, MESSAGE_KEY_JSReady)) {
    s_js_ready = true;
    if (s_pending_cmd) {
      int cmd = s_pending_cmd;
      s_pending_cmd = 0;
      send_command(cmd);
    }
  }

  Tuple *info = dict_find(iter, MESSAGE_KEY_Info);
  if (info) {
    strncpy(s_info_text, info->value->cstring, sizeof(s_info_text) - 1);
    s_info_text[sizeof(s_info_text) - 1] = '\0';
    if (s_info_layer) {
      layer_mark_dirty(text_layer_get_layer(s_info_layer));
    }
  }

  Tuple *status = dict_find(iter, MESSAGE_KEY_Status);
  if (!status) {
    return;
  }
  Tuple *message = dict_find(iter, MESSAGE_KEY_Message);
  const char *text = message ? message->value->cstring : "";
  switch (status->value->int32) {
    case STATUS_PROGRESS:
      set_status(text, GColorWhite);
      break;
    case STATUS_OK:
      finish(true, text);
      break;
    case STATUS_CONFIRM:
      ask_confirmation(text);
      break;
    default:
      finish(false, text);
      break;
  }
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  if (s_busy) {
    finish(false, "Phone not reachable");
  }
}

// False for a hold that began before the app was on screen, so that opening the app with a
// button hold never runs an action by itself: the button has to be released and held again.
static bool is_fresh_press(void) {
  return now_ms() - s_appeared_at_ms >= HOLD_MS + FRESH_PRESS_MS;
}

static void up_long_click(ClickRecognizerRef recognizer, void *context) {
  if (is_fresh_press()) {
    request(s_confirming ? CMD_UNLOCK_ANYWAY : CMD_UNLOCK);
  }
}

static void select_long_click(ClickRecognizerRef recognizer, void *context) {
  if (is_fresh_press()) {
    request(CMD_CLIMATE);
  }
}

static void down_long_click(ClickRecognizerRef recognizer, void *context) {
  if (is_fresh_press()) {
    request(CMD_LOCK);
  }
}

static void click_config_provider(void *context) {
  window_long_click_subscribe(BUTTON_ID_UP, HOLD_MS, up_long_click, NULL);
  window_long_click_subscribe(BUTTON_ID_SELECT, HOLD_MS, select_long_click, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, HOLD_MS, down_long_click, NULL);
}

static TextLayer *add_text(Layer *root, GRect frame, const char *font_key, const char *text) {
  TextLayer *layer = text_layer_create(frame);
  text_layer_set_background_color(layer, GColorClear);
  text_layer_set_text_color(layer, GColorWhite);
  text_layer_set_font(layer, fonts_get_system_font(font_key));
  text_layer_set_text_alignment(layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(layer, GTextOverflowModeWordWrap);
  text_layer_set_text(layer, text);
  layer_add_child(root, text_layer_get_layer(layer));
  return layer;
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  int16_t inset = PBL_IF_ROUND_ELSE(bounds.size.w / 7, 4);
  int16_t w = bounds.size.w - 2 * inset;
  int16_t h = bounds.size.h;

  // Stack title, info line, status and button hints. The 168/180 px tall screens need the
  // small fonts to fit everything; Pebble Time 2 and Round 2 have room for larger ones.
  bool tall = h >= 200;
  int16_t y = tall ? PBL_IF_ROUND_ELSE(28, 10) : PBL_IF_ROUND_ELSE(10, 0);
  s_title_layer = add_text(root, GRect(inset, y, w, 34), FONT_KEY_GOTHIC_28_BOLD, "EX30");

  y += tall ? 36 : 32;
  s_info_layer = add_text(root, GRect(inset, y, w, tall ? 30 : 22),
                          tall ? FONT_KEY_GOTHIC_24 : FONT_KEY_GOTHIC_18, s_info_text);
  text_layer_set_overflow_mode(s_info_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_text_color(s_info_layer, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));

  y += tall ? 32 : PBL_IF_ROUND_ELSE(20, 22);
  int16_t status_h = tall ? 72 : PBL_IF_ROUND_ELSE(54, 60);
  s_status_layer = add_text(root, GRect(inset, y, w, status_h), FONT_KEY_GOTHIC_24_BOLD,
                            s_status_text);
  text_layer_set_text_color(s_status_layer, s_status_color);

  y += status_h;
  s_hint_layer = add_text(root, GRect(inset, y, w, tall ? 66 : 52),
                          tall ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14,
                          s_confirming ? HINT_CONFIRM : HINT_DEFAULT);
}

static void window_appear(Window *window) {
  s_appeared_at_ms = now_ms();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_info_layer);
  s_info_layer = NULL;
  text_layer_destroy(s_status_layer);
  s_status_layer = NULL;
  text_layer_destroy(s_hint_layer);
  s_hint_layer = NULL;
}

static void init(void) {
  s_status_color = GColorWhite;
  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .appear = window_appear,
    .unload = window_unload,
  });

  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(128, 64);

  s_appeared_at_ms = now_ms();
  window_stack_push(s_window, true);
}

static void deinit(void) {
  cancel_timer(&s_timeout_timer);
  cancel_timer(&s_confirm_timer);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
