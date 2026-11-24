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

// How long a success message stays before the screen goes back to idle.
#define OK_SHOWN_MS 6000
#define SPIN_MS 80
#define SPIN_STEPS 12

// Lock state as the phone reports it (watchStatus in src/pkjs/volvo.js).
#define LOCK_UNKNOWN 0
#define LOCK_LOCKED 1
#define LOCK_UNLOCKED 2

typedef enum { PHASE_IDLE, PHASE_BUSY, PHASE_OK, PHASE_ERROR } Phase;
// The three actions, in button order from top to bottom.
typedef enum { ACTION_NONE = -1, ACTION_UNLOCK, ACTION_CLIMATE, ACTION_LOCK } Action;

static Window *s_window;
static Layer *s_canvas;

static Phase s_phase;
// Progress, result or error text for the current phase.
static char s_message[48];
// What the car last reported. Unknown until the phone has fetched it.
static int s_lock_state = LOCK_UNKNOWN;
static int s_battery = -1;
static bool s_climate_on;
// What is open, e.g. "Boot open"; empty when everything is shut.
static char s_open_text[24];

static bool s_js_ready;
static bool s_busy;
static int s_pending_cmd;
static bool s_confirming;
static Action s_running = ACTION_NONE;
static int s_spin;
static uint32_t s_appeared_at_ms;
static AppTimer *s_timeout_timer;
static AppTimer *s_confirm_timer;
static AppTimer *s_spin_timer;
static AppTimer *s_idle_timer;

static void redraw(void) {
  // May run before the window has loaded; the first draw picks the state up then.
  if (s_canvas) {
    layer_mark_dirty(s_canvas);
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

static void spin_timer_cb(void *context) {
  s_spin = (s_spin + 1) % SPIN_STEPS;
  s_spin_timer = app_timer_register(SPIN_MS, spin_timer_cb, NULL);
  redraw();
}

static void set_phase(Phase phase, const char *text);

static void idle_timer_cb(void *context) {
  s_idle_timer = NULL;
  set_phase(PHASE_IDLE, "");
}

static void set_phase(Phase phase, const char *text) {
  s_phase = phase;
  strncpy(s_message, text, sizeof(s_message) - 1);
  s_message[sizeof(s_message) - 1] = '\0';
  cancel_timer(&s_idle_timer);
  if (phase != PHASE_BUSY) {
    cancel_timer(&s_spin_timer);
  } else if (!s_spin_timer) {
    s_spin_timer = app_timer_register(SPIN_MS, spin_timer_cb, NULL);
  }
  if (phase == PHASE_OK) {
    s_idle_timer = app_timer_register(OK_SHOWN_MS, idle_timer_cb, NULL);
  }
  redraw();
}

static void set_confirming(bool confirming) {
  s_confirming = confirming;
  cancel_timer(&s_confirm_timer);
  redraw();
}

static void confirm_timer_cb(void *context) {
  s_confirm_timer = NULL;
  set_confirming(false);
  set_phase(PHASE_IDLE, "");
}

static void finish(bool ok, const char *text) {
  cancel_timer(&s_timeout_timer);
  s_busy = false;
  s_pending_cmd = 0;
  s_running = ACTION_NONE;
  set_phase(ok ? PHASE_OK : PHASE_ERROR, text);
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
  s_running = cmd == CMD_LOCK ? ACTION_LOCK : cmd == CMD_CLIMATE ? ACTION_CLIMATE : ACTION_UNLOCK;
  vibes_short_pulse();
  set_phase(PHASE_BUSY,
            cmd == CMD_LOCK ? "Locking..." : cmd == CMD_CLIMATE ? "Climate..." : "Unlocking...");
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

  Tuple *lock = dict_find(iter, MESSAGE_KEY_LockState);
  if (lock) {
    s_lock_state = lock->value->int32;
  }
  Tuple *battery = dict_find(iter, MESSAGE_KEY_Battery);
  if (battery) {
    s_battery = battery->value->int32;
  }
  Tuple *climate = dict_find(iter, MESSAGE_KEY_Climate);
  if (climate) {
    s_climate_on = climate->value->int32 != 0;
  }
  Tuple *info = dict_find(iter, MESSAGE_KEY_Info);
  if (info) {
    strncpy(s_open_text, info->value->cstring, sizeof(s_open_text) - 1);
    s_open_text[sizeof(s_open_text) - 1] = '\0';
  }
  redraw();

  Tuple *status = dict_find(iter, MESSAGE_KEY_Status);
  if (!status) {
    return;
  }
  Tuple *message = dict_find(iter, MESSAGE_KEY_Message);
  const char *text = message ? message->value->cstring : "";
  switch (status->value->int32) {
    case STATUS_PROGRESS:
      // Only a running command has progress to show.
      if (s_busy) {
        set_phase(PHASE_BUSY, text);
      }
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

// ---- Drawing. Everything is drawn from shapes, so it scales to every watch model. ----

#define ON_COLOR(color, mono) PBL_IF_COLOR_ELSE(color, mono)

static GRect circle_rect(GPoint centre, int16_t radius) {
  return GRect(centre.x - radius, centre.y - radius, 2 * radius + 1, 2 * radius + 1);
}

// A padlock centred on `centre`; `size` is the width of its body. `hole` is the colour behind
// it, used for the keyhole.
static void draw_padlock(GContext *ctx, GPoint centre, int16_t size, bool open, GColor color,
                         GColor hole) {
  int16_t body_h = size * 7 / 10;
  int16_t shackle_w = size * 6 / 10;
  if ((size - shackle_w) & 1) {
    shackle_w += 1;  // same parity as the body, so the shackle sits exactly in the middle
  }
  int16_t thick = size >= 20 ? size / 7 + 1 : 2;
  int16_t leg = size / 5;
  int16_t lift = open ? size / 4 : 0;
  int16_t top = centre.y - (shackle_w / 2 + leg + lift + body_h) / 2;
  int16_t left = centre.x - size / 2;
  int16_t shackle_x = left + (size - shackle_w) / 2;
  int16_t leg_y = top + shackle_w / 2;
  int16_t body_y = leg_y + leg + lift;

  graphics_context_set_fill_color(ctx, color);
  graphics_fill_radial(ctx, GRect(shackle_x, top, shackle_w, shackle_w), GOvalScaleModeFitCircle,
                       thick, DEG_TO_TRIGANGLE(270), DEG_TO_TRIGANGLE(450));
  graphics_fill_rect(ctx, GRect(shackle_x, leg_y, thick, leg + lift), 0, GCornerNone);
  // An open padlock has its right leg hanging free above the body.
  graphics_fill_rect(ctx, GRect(shackle_x + shackle_w - thick, leg_y, thick,
                                open ? (leg + 1) / 2 : leg), 0, GCornerNone);
  graphics_fill_rect(ctx, GRect(left, body_y, size, body_h), size >= 24 ? 4 : 2, GCornersAll);

  if (size >= 14) {
    int16_t r = size >= 24 ? size / 10 : 1;
    GPoint keyhole = GPoint(left + size / 2, body_y + body_h * 4 / 10);
    graphics_context_set_fill_color(ctx, hole);
    graphics_fill_circle(ctx, keyhole, r);
    if (size >= 24) {
      graphics_fill_rect(ctx, GRect(keyhole.x - r / 2, keyhole.y, r + 1, body_h * 3 / 10), 0,
                         GCornerNone);
    }
  }
}

// A thermometer centred on `centre`, `height` tall, standing for climate.
static void draw_thermometer(GContext *ctx, GPoint centre, int16_t height, GColor color,
                             GColor hole) {
  int16_t bulb_r = height / 4;
  int16_t stem_w = bulb_r | 1;
  int16_t top = centre.y - height / 2;
  int16_t x = centre.x - 1;  // the scale marks on the right balance it
  GPoint bulb = GPoint(x, top + height - bulb_r - 1);

  graphics_context_set_fill_color(ctx, color);
  graphics_fill_rect(ctx, GRect(x - stem_w / 2, top, stem_w, height - bulb_r), stem_w / 2,
                     GCornersTop);
  graphics_fill_circle(ctx, bulb, bulb_r);
  graphics_context_set_fill_color(ctx, hole);
  graphics_fill_rect(ctx, GRect(x - (stem_w - 4) / 2, top + 2, stem_w - 4,
                                (height - 2 * bulb_r) / 2), 0, GCornerNone);

  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_stroke_width(ctx, 1);
  for (int16_t i = 0; i < 3; i++) {
    int16_t y = top + 2 + i * 3;
    graphics_draw_line(ctx, GPoint(x + stem_w / 2 + 2, y), GPoint(x + stem_w / 2 + 4, y));
  }
}

// Where the icon for a button sits: next to the physical button it belongs to.
static GPoint action_centre(GRect bounds, Action action, int16_t radius) {
  int16_t step = (int16_t)action - 1;  // -1, 0, 1 from top to bottom
#if defined(PBL_ROUND)
  int32_t reach = bounds.size.w / 2 - radius - 4;
  int32_t angle = DEG_TO_TRIGANGLE(90 + step * 33);
  return GPoint(bounds.size.w / 2 + sin_lookup(angle) * reach / TRIG_MAX_RATIO,
                bounds.size.h / 2 - cos_lookup(angle) * reach / TRIG_MAX_RATIO);
#else
  return GPoint(bounds.size.w - radius - 4, bounds.size.h / 2 + step * (bounds.size.h * 3 / 10));
#endif
}

static void draw_action(GContext *ctx, GRect bounds, Action action, int16_t radius) {
  GPoint centre = action_centre(bounds, action, radius);
  bool running = s_running == action;
  // Lit while it needs attention: unlock waiting for the second hold, or climate being on.
  bool lit = (action == ACTION_UNLOCK && s_confirming) || (action == ACTION_CLIMATE && s_climate_on);
  bool filled = PBL_IF_COLOR_ELSE(true, running || lit);
  GColor fill = running ? GColorWhite : lit ? ON_COLOR(GColorOrange, GColorWhite)
                                            : ON_COLOR(GColorDarkGray, GColorBlack);
  GColor ink = running ? GColorBlack : ON_COLOR(GColorWhite, lit ? GColorBlack : GColorWhite);

  if (filled) {
    graphics_context_set_fill_color(ctx, fill);
    graphics_fill_circle(ctx, centre, radius);
  } else {
    graphics_context_set_stroke_color(ctx, GColorWhite);
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_circle(ctx, centre, radius);
  }
  if (action == ACTION_CLIMATE) {
    draw_thermometer(ctx, centre, radius * 13 / 10, ink, fill);
  } else {
    draw_padlock(ctx, centre, radius * 9 / 10, action == ACTION_UNLOCK, ink, fill);
  }
}

// The big badge: the car's lock state, with a turning ring while a command is running.
static void draw_badge(GContext *ctx, GPoint centre, int16_t radius) {
  bool locked = s_lock_state == LOCK_LOCKED;
  bool unlocked = s_lock_state == LOCK_UNLOCKED;
  GColor fill = locked ? ON_COLOR(GColorIslamicGreen, GColorWhite)
                       : unlocked ? ON_COLOR(GColorOrange, GColorBlack)
                                  : ON_COLOR(GColorDarkGray, GColorBlack);
  GColor ink = ON_COLOR(GColorWhite, locked ? GColorBlack : GColorWhite);

  graphics_context_set_fill_color(ctx, fill);
  graphics_fill_circle(ctx, centre, radius);
#if defined(PBL_BW)
  // Without colour, a solid badge means locked, a heavy ring unlocked, a thin ring unknown.
  if (!locked) {
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_radial(ctx, circle_rect(centre, radius), GOvalScaleModeFitCircle,
                         unlocked ? 3 : 1, 0, TRIG_MAX_ANGLE);
  }
#endif
  draw_padlock(ctx, centre, radius, unlocked, ink, fill);

  if (s_phase == PHASE_BUSY) {
    int32_t start = TRIG_MAX_ANGLE * s_spin / SPIN_STEPS;
    graphics_context_set_fill_color(ctx, GColorWhite);
    graphics_fill_radial(ctx, circle_rect(centre, radius + 6), GOvalScaleModeFitCircle, 3, start,
                         start + TRIG_MAX_ANGLE / 4);
  }
}

static int16_t text_width(const char *text, GFont font) {
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, 200, 40),
                                               GTextOverflowModeTrailingEllipsis,
                                               GTextAlignmentLeft).w;
}

// A battery outline filled to the car's charge level, with the percentage beside it.
static void draw_gauge(GContext *ctx, int16_t centre_x, int16_t y, bool big) {
  char percent[8];
  snprintf(percent, sizeof(percent), "%d%%", s_battery);
  GFont font = fonts_get_system_font(big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD);
  int16_t w = big ? 34 : 26;
  int16_t h = big ? 16 : 12;
  int16_t gap = big ? 8 : 6;
  int16_t label_w = text_width(percent, font);
  int16_t x = centre_x - (w + 2 + gap + label_w) / 2;

  graphics_context_set_stroke_color(ctx, GColorWhite);
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_round_rect(ctx, GRect(x, y, w, h), 2);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, GRect(x + w, y + h / 4, 2, h - 2 * (h / 4)), 0, GCornerNone);

  int16_t level = (w - 4) * s_battery / 100;
  if (level < 2 && s_battery > 0) {
    level = 2;
  }
  graphics_context_set_fill_color(ctx, s_battery >= 30 ? ON_COLOR(GColorGreen, GColorWhite)
                                       : s_battery >= 15 ? ON_COLOR(GColorChromeYellow, GColorWhite)
                                                         : ON_COLOR(GColorRed, GColorWhite));
  graphics_fill_rect(ctx, GRect(x + 2, y + 2, level, h - 4), 0, GCornerNone);

  graphics_context_set_text_color(ctx, GColorWhite);
  // System fonts sit low in their box; the offset lines the digits up with the outline.
  graphics_draw_text(ctx, percent, font, GRect(x + w + 2 + gap, y - (big ? 9 : 7), label_w + 4, 30),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static int16_t wrapped_height(const char *text, GFont font, int16_t width) {
  return graphics_text_layout_get_content_size(text, font, GRect(0, 0, width, 200),
                                               GTextOverflowModeWordWrap,
                                               GTextAlignmentCenter).h;
}

// The lines under the car's state: what is going on, or what to do. Centred in `area`.
static void draw_message(GContext *ctx, GRect area, bool big) {
  GFont large = fonts_get_system_font(big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD);
  GFont small = fonts_get_system_font(big ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14);
  const char *text = s_message;
  const char *hint = s_confirming ? "Hold UP again" : NULL;
  GFont font = large;
  GColor color = GColorWhite;
  if (s_phase == PHASE_IDLE) {
    text = "Hold a button";
    font = small;
    color = ON_COLOR(GColorLightGray, GColorWhite);
  } else if (s_phase == PHASE_OK) {
    color = ON_COLOR(GColorGreen, GColorWhite);
  } else if (s_phase == PHASE_ERROR) {
    color = ON_COLOR(GColorChromeYellow, GColorWhite);
  }

  int16_t hint_h = hint ? wrapped_height(hint, small, area.size.w) + 2 : 0;
  int16_t text_h = wrapped_height(text, font, area.size.w);
  if (text_h + hint_h > area.size.h && font == large) {
    // A long message: the smaller font fits a third line.
    font = small;
    text_h = wrapped_height(text, font, area.size.w);
  }
  // Text is drawn a few pixels below the top of its box, so pull the block up a little.
  int16_t y = area.origin.y + (area.size.h - text_h - hint_h) / 2 - 3;
  if (y < area.origin.y - 4) {
    y = area.origin.y - 4;
  }
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, font, GRect(area.origin.x, y, area.size.w, text_h + 8),
                     GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
  if (hint) {
    graphics_context_set_text_color(ctx, GColorWhite);
    graphics_draw_text(ctx, hint, small, GRect(area.origin.x, y + text_h + 2, area.size.w, hint_h + 8),
                       GTextOverflowModeWordWrap, GTextAlignmentCenter, NULL);
  }
}

static void canvas_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  int16_t w = bounds.size.w;
  int16_t h = bounds.size.h;
  // Pebble Time 2 and Round 2 have room for larger shapes and fonts.
  bool big = h >= 200;
  bool huge = h >= 250;
  int16_t action_r = huge ? 19 : big ? 17 : 13;
  int16_t badge_r = huge ? 40 : big ? 32 : 22;

  draw_action(ctx, bounds, ACTION_UNLOCK, action_r);
  draw_action(ctx, bounds, ACTION_CLIMATE, action_r);
  draw_action(ctx, bounds, ACTION_LOCK, action_r);

  // Everything else goes in a column to the left of the button icons.
  int16_t left = PBL_IF_ROUND_ELSE(w / 8, 2);
  int16_t right = w - 2 * action_r - PBL_IF_ROUND_ELSE(10, 8);
  int16_t col_w = right - left;
  int16_t centre_x = left + col_w / 2;
  int16_t y = PBL_IF_ROUND_ELSE(h / 12, big ? 14 : 9);

  draw_badge(ctx, GPoint(centre_x, y + badge_r), badge_r);
  y += 2 * badge_r + (big ? 4 : 1);

  // Something left open matters more than the lock state, which the badge shows anyway.
  bool open = s_open_text[0] != '\0';
  const char *label = open ? s_open_text
                           : s_lock_state == LOCK_LOCKED ? "Locked"
                           : s_lock_state == LOCK_UNLOCKED ? "Unlocked" : "PebbleKey";
  graphics_context_set_text_color(ctx, open ? ON_COLOR(GColorChromeYellow, GColorWhite) : GColorWhite);
  graphics_draw_text(ctx, label,
                     fonts_get_system_font(big ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD),
                     GRect(left, y, col_w, big ? 34 : 30), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);
  y += big ? 38 : 32;

  if (s_battery >= 0) {
    draw_gauge(ctx, centre_x, y, big);
    y += big ? 24 : 18;
  }

  int16_t bottom = h - PBL_IF_ROUND_ELSE(h / 9, 2);
  // On a round screen the lowest button icon reaches into the column, so the message gets a
  // narrower strip that stays clear of it.
  int16_t half = PBL_IF_ROUND_ELSE(
      action_centre(bounds, ACTION_LOCK, action_r).x - action_r - 4 - centre_x, col_w / 2);
  draw_message(ctx, GRect(centre_x - half, y, 2 * half, bottom - y), big);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
}

static void window_appear(Window *window) {
  s_appeared_at_ms = now_ms();
}

static void window_unload(Window *window) {
  layer_destroy(s_canvas);
  s_canvas = NULL;
}

static void init(void) {
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
  cancel_timer(&s_spin_timer);
  cancel_timer(&s_idle_timer);
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
