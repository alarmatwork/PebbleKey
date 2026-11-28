#include <pebble.h>

// Commands sent to the phone (src/pkjs/index.js mirrors these).
#define CMD_UNLOCK 1
#define CMD_LOCK 2
#define CMD_CLIMATE 4  // phone starts or stops climate, whichever applies
#define CMD_UNLOCK_ANYWAY 5  // unlock without the distance check, after the user confirmed
#define CMD_TOGGLE 6  // phone asks the car, then locks or unlocks, whichever undoes its state
#define CMD_EXTRA 7  // one of the DOWN menu's items, named by the Item key

// Status values received from the phone.
#define STATUS_PROGRESS 0
#define STATUS_OK 1
#define STATUS_ERROR 2
#define STATUS_CONFIRM 3  // phone is not near the car; ask for a second hold to unlock
#define STATUS_NOTICE 4  // something the user should know although no command is running

#define HOLD_MS 700
// Long enough for the phone to wait out a slow car (110 s) and then check on it.
#define REPLY_TIMEOUT_MS 150000
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

// The DOWN menu, as the phone sends it: "id:title" lines.
#define MENU_MAX_ITEMS 8
#define MENU_PERSIST_KEY 1
#define DETAILS_MAX 320

typedef enum { PHASE_IDLE, PHASE_BUSY, PHASE_OK, PHASE_ERROR } Phase;
// The three actions, in button order from top to bottom.
typedef enum { ACTION_NONE = -1, ACTION_TOGGLE, ACTION_CLIMATE, ACTION_MORE } Action;

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
static bool s_charging;
// What to say about charging, e.g. "Charging to 80%\n1 h 20 min left"; empty when there is
// nothing to say.
static char s_charge_text[40];

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
// Which menu item CMD_EXTRA runs.
static char s_extra_id[16];

// The DOWN menu as the phone sent it, and a copy of it cut up in place into ids and titles.
static char s_menu_raw[160];
static char s_menu_text[160];
static char *s_menu_ids[MENU_MAX_ITEMS];
static char *s_menu_titles[MENU_MAX_ITEMS];
static int s_menu_count;
static Window *s_menu_window;
static MenuLayer *s_menu_layer;

// The details screen, e.g. for Car info.
static Window *s_details_window;
static ScrollLayer *s_details_scroll;
static TextLayer *s_details_title_layer;
static TextLayer *s_details_layer;
static char s_details_title[48];
static char s_details[DETAILS_MAX];

#define ON_COLOR(color, mono) PBL_IF_COLOR_ELSE(color, mono)

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
  if (cmd == CMD_EXTRA) {
    dict_write_cstring(iter, MESSAGE_KEY_Item, s_extra_id);
  }
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
  s_running = cmd == CMD_CLIMATE ? ACTION_CLIMATE : cmd == CMD_EXTRA ? ACTION_MORE : ACTION_TOGGLE;
  vibes_short_pulse();
  set_phase(PHASE_BUSY, cmd == CMD_LOCK ? "Locking..."
                        : cmd == CMD_UNLOCK || cmd == CMD_UNLOCK_ANYWAY ? "Unlocking..."
                        : cmd == CMD_CLIMATE ? "Climate..."
                        : cmd == CMD_TOGGLE ? "Checking lock..." : "Asking car...");
  cancel_timer(&s_timeout_timer);
  s_timeout_timer = app_timer_register(REPLY_TIMEOUT_MS, timeout_timer_cb, NULL);
  if (s_js_ready) {
    send_command(cmd);
  } else {
    // The phone-side JS is still starting; send as soon as it reports ready.
    s_pending_cmd = cmd;
  }
}

// ---- The DOWN menu ----

// Cut "id:title\nid:title" into the item arrays.
static void parse_menu(void) {
  strncpy(s_menu_text, s_menu_raw, sizeof(s_menu_text));
  s_menu_count = 0;
  char *line = s_menu_text;
  while (line && *line && s_menu_count < MENU_MAX_ITEMS) {
    char *next = strchr(line, '\n');
    if (next) {
      *next++ = '\0';
    }
    char *colon = strchr(line, ':');
    if (colon) {
      *colon = '\0';
      s_menu_ids[s_menu_count] = line;
      s_menu_titles[s_menu_count] = colon + 1;
      s_menu_count++;
    }
    line = next;
  }
}

static void set_menu(const char *text) {
  strncpy(s_menu_raw, text, sizeof(s_menu_raw) - 1);
  s_menu_raw[sizeof(s_menu_raw) - 1] = '\0';
  persist_write_string(MENU_PERSIST_KEY, s_menu_raw);
  parse_menu();
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
}

static uint16_t menu_get_num_rows(MenuLayer *layer, uint16_t section, void *context) {
  return s_menu_count;
}

static void menu_draw_row(GContext *ctx, const Layer *cell, MenuIndex *index, void *context) {
  menu_cell_basic_draw(ctx, cell, s_menu_titles[index->row], NULL, NULL);
}

static void request(int cmd);

static void menu_select(MenuLayer *layer, MenuIndex *index, void *context) {
  if (index->row >= s_menu_count) {
    return;
  }
  strncpy(s_extra_id, s_menu_ids[index->row], sizeof(s_extra_id) - 1);
  s_extra_id[sizeof(s_extra_id) - 1] = '\0';
  window_stack_remove(s_menu_window, true);
  request(CMD_EXTRA);
}

static void menu_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_menu_layer = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_rows = menu_get_num_rows,
    .draw_row = menu_draw_row,
    .select_click = menu_select,
  });
  menu_layer_set_normal_colors(s_menu_layer, GColorBlack, GColorWhite);
  menu_layer_set_highlight_colors(s_menu_layer, ON_COLOR(GColorOrange, GColorWhite), GColorBlack);
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void menu_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

static void open_menu(void) {
  if (!s_menu_window) {
    s_menu_window = window_create();
    window_set_background_color(s_menu_window, GColorBlack);
    window_set_window_handlers(s_menu_window, (WindowHandlers) {
      .load = menu_window_load,
      .unload = menu_window_unload,
    });
  }
  window_stack_push(s_menu_window, true);
}

// ---- The details screen ----

static void details_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  bool big = bounds.size.h >= 200;
  int16_t inset = PBL_IF_ROUND_ELSE(bounds.size.w / 8, 4);
  int16_t width = bounds.size.w - 2 * inset;
  GFont title_font = fonts_get_system_font(big ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD);
  GFont font = fonts_get_system_font(big ? FONT_KEY_GOTHIC_24 : FONT_KEY_GOTHIC_18);
  int16_t top = PBL_IF_ROUND_ELSE(bounds.size.h / 8, 0);

  s_details_scroll = scroll_layer_create(bounds);
  scroll_layer_set_click_config_onto_window(s_details_scroll, window);
  scroll_layer_set_shadow_hidden(s_details_scroll, true);

  GSize title_size = graphics_text_layout_get_content_size(
      s_details_title, title_font, GRect(0, 0, width, 200), GTextOverflowModeWordWrap,
      GTextAlignmentCenter);
  s_details_title_layer = text_layer_create(GRect(inset, top, width, title_size.h + 6));
  text_layer_set_text(s_details_title_layer, s_details_title);
  text_layer_set_font(s_details_title_layer, title_font);
  text_layer_set_text_alignment(s_details_title_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_details_title_layer, GColorClear);
  text_layer_set_text_color(s_details_title_layer, GColorWhite);

  int16_t body_y = top + title_size.h + 8;
  GSize body_size = graphics_text_layout_get_content_size(
      s_details, font, GRect(0, 0, width, 2000), GTextOverflowModeWordWrap,
      PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  s_details_layer = text_layer_create(GRect(inset, body_y, width, body_size.h + 8));
  text_layer_set_text(s_details_layer, s_details);
  text_layer_set_font(s_details_layer, font);
  text_layer_set_text_alignment(s_details_layer, PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft));
  text_layer_set_background_color(s_details_layer, GColorClear);
  text_layer_set_text_color(s_details_layer, GColorWhite);

  scroll_layer_add_child(s_details_scroll, text_layer_get_layer(s_details_title_layer));
  scroll_layer_add_child(s_details_scroll, text_layer_get_layer(s_details_layer));
  scroll_layer_set_content_size(s_details_scroll,
      GSize(bounds.size.w, body_y + body_size.h + 8 + PBL_IF_ROUND_ELSE(bounds.size.h / 6, 4)));
  layer_add_child(root, scroll_layer_get_layer(s_details_scroll));
}

static void details_window_unload(Window *window) {
  text_layer_destroy(s_details_layer);
  text_layer_destroy(s_details_title_layer);
  scroll_layer_destroy(s_details_scroll);
  s_details_layer = NULL;
  s_details_title_layer = NULL;
  s_details_scroll = NULL;
}

static void show_details(const char *title, const char *text) {
  strncpy(s_details_title, title, sizeof(s_details_title) - 1);
  s_details_title[sizeof(s_details_title) - 1] = '\0';
  strncpy(s_details, text, sizeof(s_details) - 1);
  s_details[sizeof(s_details) - 1] = '\0';
  if (!s_details_window) {
    s_details_window = window_create();
    window_set_background_color(s_details_window, GColorBlack);
    window_set_window_handlers(s_details_window, (WindowHandlers) {
      .load = details_window_load,
      .unload = details_window_unload,
    });
  }
  // Showing new details: rebuild the layers for the new text.
  if (window_stack_contains_window(s_details_window)) {
    window_stack_remove(s_details_window, false);
  }
  window_stack_push(s_details_window, true);
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
  Tuple *charging = dict_find(iter, MESSAGE_KEY_Charging);
  if (charging) {
    s_charging = charging->value->int32 != 0;
  }
  Tuple *charge = dict_find(iter, MESSAGE_KEY_ChargeInfo);
  if (charge) {
    strncpy(s_charge_text, charge->value->cstring, sizeof(s_charge_text) - 1);
    s_charge_text[sizeof(s_charge_text) - 1] = '\0';
  }
  Tuple *menu = dict_find(iter, MESSAGE_KEY_Menu);
  if (menu && menu->length > 1 && strcmp(menu->value->cstring, s_menu_raw) != 0) {
    set_menu(menu->value->cstring);
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
    case STATUS_OK: {
      finish(true, text);
      Tuple *details = dict_find(iter, MESSAGE_KEY_Details);
      if (details && details->length > 1) {
        show_details(text, details->value->cstring);
      }
      break;
    }
    case STATUS_CONFIRM:
      ask_confirmation(text);
      break;
    case STATUS_NOTICE:
      // A running command reports its own result, so it is not interrupted.
      if (!s_busy) {
        set_confirming(false);
        set_phase(PHASE_ERROR, text);
        vibes_double_pulse();
      }
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

// UP locks an unlocked car and unlocks a locked one. After the phone held an unlock back
// because the car is far away, the next hold confirms that unlock.
static void up_long_click(ClickRecognizerRef recognizer, void *context) {
  if (is_fresh_press()) {
    request(s_confirming ? CMD_UNLOCK_ANYWAY : CMD_TOGGLE);
  }
}

static void select_long_click(ClickRecognizerRef recognizer, void *context) {
  if (is_fresh_press()) {
    request(CMD_CLIMATE);
  }
}

static void down_long_click(ClickRecognizerRef recognizer, void *context) {
  if (is_fresh_press() && !s_busy) {
    open_menu();
  }
}

static void click_config_provider(void *context) {
  window_long_click_subscribe(BUTTON_ID_UP, HOLD_MS, up_long_click, NULL);
  window_long_click_subscribe(BUTTON_ID_SELECT, HOLD_MS, select_long_click, NULL);
  window_long_click_subscribe(BUTTON_ID_DOWN, HOLD_MS, down_long_click, NULL);
}

// ---- Drawing. Everything is drawn from shapes, so it scales to every watch model. ----

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

// Three dots: the DOWN button opens a menu of more.
static void draw_dots(GContext *ctx, GPoint centre, int16_t radius, GColor color) {
  int16_t r = radius >= 17 ? 3 : 2;
  int16_t gap = radius * 4 / 10;
  graphics_context_set_fill_color(ctx, color);
  for (int16_t i = -1; i <= 1; i++) {
    graphics_fill_circle(ctx, GPoint(centre.x + i * gap, centre.y), r);
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
  bool lit = (action == ACTION_TOGGLE && s_confirming) || (action == ACTION_CLIMATE && s_climate_on);
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
  } else if (action == ACTION_MORE) {
    draw_dots(ctx, centre, radius, ink);
  } else {
    // What a hold does: an open padlock unlocks a locked car, a shut one locks.
    draw_padlock(ctx, centre, radius * 9 / 10, s_lock_state == LOCK_LOCKED || s_confirming, ink,
                 fill);
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

// A lightning bolt about as tall as the battery outline, in two sizes. Each row is the start
// and the width of its filled pixels; a shape this thin comes out ragged as a filled path.
static const uint8_t BOLT_SMALL[][2] = {
  {4, 2}, {3, 2}, {2, 3}, {1, 3}, {1, 6}, {0, 6}, {3, 3}, {2, 3}, {2, 2}, {1, 2}, {1, 1},
};
static const uint8_t BOLT_BIG[][2] = {
  {6, 2}, {5, 2}, {4, 3}, {3, 3}, {2, 4}, {1, 4}, {1, 8}, {0, 8},
  {4, 4}, {4, 3}, {3, 3}, {3, 2}, {2, 2}, {2, 1}, {1, 1},
};

static void draw_bolt(GContext *ctx, int16_t x, int16_t y, bool big) {
  const uint8_t (*rows)[2] = big ? BOLT_BIG : BOLT_SMALL;
  int16_t count = big ? ARRAY_LENGTH(BOLT_BIG) : ARRAY_LENGTH(BOLT_SMALL);
  graphics_context_set_fill_color(ctx, ON_COLOR(GColorYellow, GColorWhite));
  for (int16_t i = 0; i < count; i++) {
    graphics_fill_rect(ctx, GRect(x + rows[i][0], y + i, rows[i][1], 1), 0, GCornerNone);
  }
}

// A battery outline filled to the car's charge level, with the percentage beside it and a
// lightning bolt in front of it while the car is charging.
static void draw_gauge(GContext *ctx, int16_t centre_x, int16_t y, bool big) {
  char percent[12];
  snprintf(percent, sizeof(percent), "%d%%", s_battery);
  GFont font = fonts_get_system_font(big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD);
  int16_t w = big ? 34 : 26;
  int16_t h = big ? 16 : 12;
  int16_t gap = big ? 8 : 6;
  int16_t bolt_w = s_charging ? (big ? 13 : 10) : 0;  // the bolt and the space after it
  int16_t label_w = text_width(percent, font);
  int16_t x = centre_x - (bolt_w + w + 2 + gap + label_w) / 2;

  if (s_charging) {
    draw_bolt(ctx, x, y, big);
    x += bolt_w;
  }

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
    // Nothing is running: say how charging is going, if it is.
    bool charge = s_charge_text[0] != '\0';
    text = charge ? s_charge_text : "Hold a button";
    font = small;
    color = charge ? GColorWhite : ON_COLOR(GColorLightGray, GColorWhite);
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

  draw_action(ctx, bounds, ACTION_TOGGLE, action_r);
  draw_action(ctx, bounds, ACTION_CLIMATE, action_r);
  draw_action(ctx, bounds, ACTION_MORE, action_r);

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
      action_centre(bounds, ACTION_MORE, action_r).x - action_r - 4 - centre_x, col_w / 2);
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
  // Car info and the menu come in longer messages than the car's state alone.
  app_message_open(512, 64);

  // The menu as the phone last sent it, so DOWN works before the phone has answered.
  if (persist_read_string(MENU_PERSIST_KEY, s_menu_raw, sizeof(s_menu_raw)) <= 0) {
    strncpy(s_menu_raw, "info:Car info", sizeof(s_menu_raw) - 1);
  }
  parse_menu();

  s_appeared_at_ms = now_ms();
  window_stack_push(s_window, true);
}

static void deinit(void) {
  cancel_timer(&s_timeout_timer);
  cancel_timer(&s_confirm_timer);
  cancel_timer(&s_spin_timer);
  cancel_timer(&s_idle_timer);
  if (s_menu_window) {
    window_destroy(s_menu_window);
  }
  if (s_details_window) {
    window_destroy(s_details_window);
  }
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
