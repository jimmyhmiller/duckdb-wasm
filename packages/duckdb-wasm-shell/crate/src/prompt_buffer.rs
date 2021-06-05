use crate::vt100;
use crate::xterm::Terminal;
use ropey::Rope;
use std::fmt::Write;
use web_sys::KeyboardEvent;

const PROMPT_INIT: &'static str = "\x1b[1mduckdb\x1b[m> ";
const PROMPT_ENDL: &'static str = "\x1b[1m   ...\x1b[m> ";
const PROMPT_WRAP: &'static str = "\x1b[1m   ..\x1b[m>> ";
const PROMPT_WIDTH: usize = 8;
const TAB_WIDTH: usize = 2;

pub struct PromptBuffer {
    /// The pending output buffer
    output_buffer: String,
    /// The input buffer
    text_buffer: Rope,
    /// The iterator
    cursor: usize,
    /// The terminal width
    terminal_width: usize,
}

impl PromptBuffer {
    /// Construct prompt buffer
    pub fn default() -> Self {
        Self {
            output_buffer: String::new(),
            text_buffer: Rope::new(),
            cursor: 0,
            terminal_width: 0,
        }
    }

    /// Configure the terminal
    pub fn configure(&mut self, term: &Terminal) {
        self.terminal_width = term.get_cols() as usize;
    }

    /// Flush output buffer to the terminal
    pub fn flush(&mut self, term: &Terminal) {
        term.write(&self.output_buffer);
        self.output_buffer.clear();
    }

    /// Collect as string.
    /// We replace all paragraph separators with real line feeds for the user.
    pub fn collect(&mut self) -> String {
        let buffer: String = self
            .text_buffer
            .chars()
            .map(|c| match c {
                vt100::PARAGRAPH_SEPERATOR => '\n',
                c => c,
            })
            .collect();
        buffer
    }

    /// Reset the prompt
    pub fn start_new(&mut self) {
        self.output_buffer.clear();
        self.text_buffer = Rope::new();
        self.cursor = 0;
        write!(self.output_buffer, "{}", PROMPT_INIT).unwrap();
    }

    /// Insert a newline at the cursor.
    /// Writes the prompt continuation string and reflows if the cursor is not at the end.
    fn insert_newline(&mut self) {
        // Insert a newline character
        self.text_buffer.insert_char(self.cursor, '\n');
        write!(
            self.output_buffer,
            "{endl}{prompt_cont}",
            endl = vt100::CRLF,
            prompt_cont = PROMPT_ENDL
        )
        .unwrap();
        self.cursor += 1;

        // Reflow if cursor is not at end
        let pos = self.cursor;
        if pos != self.text_buffer.len_chars() {
            self.reflow(|_| ());
            self.move_cursor_to(pos);
        }
    }

    /// Clear the output
    fn erase_prompt(&mut self) {
        // Is only a single line?
        // Just clear the line and move cursor to the beginning.
        let line_idx = self.text_buffer.char_to_line(self.cursor);
        let line_count = self.text_buffer.len_lines();
        if line_count == 1 {
            self.output_buffer.push_str(vt100::CLEAR_LINE);
            self.output_buffer.push(vt100::CR);
            self.cursor = 0;
            return;
        }

        // Move cursor to the last line
        assert!(line_idx < line_count);
        self.output_buffer.push(vt100::CR);
        if (line_idx + 1) < line_count {
            vt100::cursor_down(&mut self.output_buffer, (line_count - 1) - line_idx);
        }

        // Clear all lines
        self.output_buffer.push_str(vt100::CLEAR_LINE);
        for _ in 1..line_count {
            self.output_buffer.push_str(vt100::CURSOR_UP);
            self.output_buffer.push_str(vt100::CLEAR_LINE);
        }
        self.cursor = 0;
    }

    /// Move cursor to position in prompt text
    fn move_cursor_to(&mut self, pos: usize) {
        let src_line_id = self.text_buffer.char_to_line(self.cursor);
        let dst_line_id = self.text_buffer.char_to_line(pos);
        if src_line_id < dst_line_id {
            vt100::cursor_down(&mut self.output_buffer, dst_line_id - src_line_id);
        } else if src_line_id > dst_line_id {
            vt100::cursor_up(&mut self.output_buffer, src_line_id - dst_line_id);
        }
        let src_col = self.cursor - self.text_buffer.line_to_char(src_line_id);
        let dst_col = pos - self.text_buffer.line_to_char(dst_line_id);
        if src_col < dst_col {
            vt100::cursor_right(&mut self.output_buffer, dst_col - src_col);
        } else if src_col > dst_col {
            vt100::cursor_left(&mut self.output_buffer, src_col - dst_col);
        }
        self.cursor = pos;
    }

    // Move the cursor 1 to the left
    fn move_cursor_left(&mut self) {
        let mut iter = self.text_buffer.chars_at(self.cursor);
        match iter.prev() {
            Some(c) => {
                match c {
                    // Move to end of previous line?
                    '\n' | vt100::PARAGRAPH_SEPERATOR => {
                        let line_id = self.text_buffer.char_to_line(self.cursor - 1);
                        let line = self.text_buffer.line(line_id);
                        write!(
                            self.output_buffer,
                            "{rewind}{cursor_up}",
                            rewind = vt100::CR,
                            cursor_up = vt100::CURSOR_UP
                        )
                        .unwrap();
                        vt100::cursor_right(
                            &mut self.output_buffer,
                            PROMPT_WIDTH + line.len_chars() - 1,
                        );
                    }
                    // Just cursor one to the left
                    _ => write!(
                        self.output_buffer,
                        "{cursor_left}",
                        cursor_left = vt100::CURSOR_LEFT
                    )
                    .unwrap(),
                }
                self.cursor -= 1;
            }
            // Reached beginning of input
            None => return,
        }
    }

    // Move the cursor 1 to the right
    fn move_cursor_right(&mut self) {
        let mut iter = self.text_buffer.chars_at(self.cursor);
        match iter.next() {
            Some(c) => {
                match c {
                    // Move to beginning of previous line?
                    '\n' | vt100::PARAGRAPH_SEPERATOR => {
                        write!(
                            self.output_buffer,
                            "{rewind}{cursor_down}",
                            rewind = vt100::CR,
                            cursor_down = vt100::CURSOR_DOWN
                        )
                        .unwrap();
                        vt100::cursor_right(&mut self.output_buffer, PROMPT_WIDTH);
                    }
                    // Just cursor one to the right
                    _ => write!(
                        self.output_buffer,
                        "{cursor_right}",
                        cursor_right = vt100::CURSOR_RIGHT
                    )
                    .unwrap(),
                }
                self.cursor += 1;
            }
            // Reached end of input
            None => return,
        }
    }

    /// Reflow the text buffer
    fn reflow<F>(&mut self, modify: F)
    where
        F: Fn(&mut Rope) -> (),
    {
        // First erase the prompt since we need a valid text buffer for clearing
        self.erase_prompt();
        // Then adjust the rope with the provided function
        modify(&mut self.text_buffer);

        // Rebuild text and output
        let mut reflowed_txt = String::new();
        let mut reflowed_out = String::new();
        let mut line_length = PROMPT_WIDTH;
        write!(&mut reflowed_out, "{}", PROMPT_INIT).unwrap();

        // Write all chars in the rope
        for c in self.text_buffer.chars() {
            match c {
                // Skip artifical line wraps
                vt100::PARAGRAPH_SEPERATOR => {}

                // Preserve explicit newlines
                '\n' => {
                    reflowed_txt.push('\n');
                    write!(
                        &mut reflowed_out,
                        "{endl}{prompt_cont}",
                        endl = vt100::CRLF,
                        prompt_cont = PROMPT_ENDL
                    )
                    .unwrap();
                    line_length = PROMPT_WIDTH;
                }

                // Write all other characters and wrap lines if necessary
                _ => {
                    reflowed_txt.push(c);
                    reflowed_out.push(c);
                    line_length += 1;
                    if (line_length + 1) >= self.terminal_width {
                        reflowed_txt.push(vt100::PARAGRAPH_SEPERATOR);
                        write!(
                            reflowed_out,
                            "{endl}{prompt_wrap}",
                            endl = vt100::CRLF,
                            prompt_wrap = PROMPT_WRAP
                        )
                        .unwrap();
                        line_length = PROMPT_WIDTH;
                    }
                }
            }
        }

        // Rewrite the entire prompt
        self.output_buffer.push_str(&reflowed_out);
        self.text_buffer = Rope::from_str(&reflowed_txt);
        self.cursor = self.text_buffer.len_chars();
    }

    /// Insert a single character at the cursor.
    /// Takes care of line wrapping, if necessary
    fn insert_char(&mut self, c: char) {
        // Cursor is at end?
        // We short-circuit that case since we don't need to take care of following lines.
        if self.cursor == self.text_buffer.len_chars() {
            let line_id = self.text_buffer.char_to_line(self.cursor);
            let line = match self.text_buffer.lines_at(line_id).next() {
                Some(rope) => rope,
                None => return,
            };
            if (PROMPT_WIDTH + line.len_chars() + 1) >= self.terminal_width {
                // Insert an artificial newline as line wrap at the cursor.
                // The rope interprets the paragraph separator as newline.
                // We can therefore use the character as 'artificial' newline character and skip it during reflows.
                self.text_buffer
                    .insert_char(self.cursor, vt100::PARAGRAPH_SEPERATOR);
                write!(
                    self.output_buffer,
                    "{endl}{prompt_wrap}",
                    endl = vt100::CRLF,
                    prompt_wrap = PROMPT_WRAP
                )
                .unwrap();
                self.cursor += 1;
            }
            self.text_buffer.insert_char(self.cursor, c);
            self.cursor += 1;
            self.output_buffer.push(c);
        } else {
            // Otherwise reflow since we might need new line-wraps
            let pos = self.cursor;
            self.reflow(|buffer| buffer.insert_char(pos, c));
            self.move_cursor_to(pos + 1);
        }
    }

    /// Erase the previous character
    fn erase_previous_char(&mut self) {
        let mut iter = self.text_buffer.chars_at(self.cursor);
        match iter.prev() {
            Some(c) => {
                match c {
                    // Remove explicit newline?
                    // Removing newlines is expensive since we have to reflow the following lines.
                    '\n' => {
                        let pos = self.cursor;
                        self.reflow(|buffer| buffer.remove((pos - 1)..pos));
                        self.move_cursor_to(pos - 1);
                    }

                    // Previous character is an artificial line wrap?
                    // In that case, we'll delete the character before that character.
                    vt100::PARAGRAPH_SEPERATOR => {
                        let pos = self.cursor;
                        let begin = std::cmp::max(pos, 2) - 2;
                        self.reflow(|buffer| buffer.remove(begin..pos));
                        self.move_cursor_to(begin);
                    }

                    // In all other cases, just remove the character
                    _ => {
                        let pos = self.cursor;
                        if pos == self.text_buffer.len_chars() {
                            write!(self.output_buffer, "{}", "\u{0008} \u{0008}").unwrap();
                            self.text_buffer.remove((self.cursor - 1)..(self.cursor));
                            self.cursor -= 1;
                        } else {
                            self.reflow(|buffer| buffer.remove((pos - 1)..(pos)));
                            self.move_cursor_to(pos - 1);
                        }
                    }
                }
            }
            None => return,
        }
    }

    /// Insert 4 spaces without line wraps
    pub fn insert_tab(&mut self) {
        let line = self.text_buffer.char_to_line(self.cursor);
        let col = PROMPT_WIDTH + self.cursor - self.text_buffer.line_to_char(line);
        let ub = self.terminal_width - 1;
        for _ in 0..(std::cmp::min(ub - col, TAB_WIDTH)) {
            self.text_buffer.insert_char(self.cursor, ' ');
            self.cursor += 1;
            self.output_buffer.push(' ');
        }
    }

    /// Process key event
    pub fn consume(&mut self, event: KeyboardEvent) {
        match event.key_code() {
            vt100::KEY_TAB => self.insert_tab(),
            vt100::KEY_ENTER => self.insert_newline(),
            vt100::KEY_BACKSPACE => self.erase_previous_char(),
            vt100::KEY_ARROW_UP | vt100::KEY_ARROW_DOWN => return,
            vt100::KEY_ARROW_LEFT => self.move_cursor_left(),
            vt100::KEY_ARROW_RIGHT => self.move_cursor_right(),
            _ => {
                if !event.alt_key() && !event.alt_key() && !event.ctrl_key() && !event.meta_key() {
                    self.insert_char(event.key().chars().next().unwrap());
                }
            }
        }
    }
}