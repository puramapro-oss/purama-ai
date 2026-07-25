import { useEffect, useRef, useState } from 'react';

const CHARS = '!<>-_\\/[]{}=+*^?#█▓▒░';

interface Props {
  text: string;
  delay?: number;
  speed?: number;
  className?: string;
}

export function TextScramble({ text, delay = 0, speed = 28, className }: Props) {
  const [display, setDisplay] = useState('');
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  useEffect(() => {
    if (!started) return;
    let frame = 0;
    const totalFrames = text.length * 3;
    const id = setInterval(() => {
      const progress = frame / totalFrames;
      const revealed = Math.floor(progress * text.length);
      let result = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ') { result += ' '; continue; }
        if (i < revealed) {
          result += text[i];
        } else {
          result += CHARS[Math.floor(Math.random() * CHARS.length)];
        }
      }
      setDisplay(result);
      frame++;
      if (frame > totalFrames) {
        setDisplay(text);
        clearInterval(id);
      }
    }, speed);
    return () => clearInterval(id);
  }, [started, text, speed]);

  return (
    <span ref={ref} className={className} aria-label={text}>
      {display || '\u00A0'}
    </span>
  );
}
