import { useEffect, useRef, type ReactElement } from 'react';
import type { LogEntry } from '@shared/types';

interface Props {
  logs: LogEntry[];
}

export function LogPanel({ logs }: Props): ReactElement {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [logs.length]);
  return (
    <>
      <h2>ログ</h2>
      <pre className="log">
        {logs.slice(-200).map((entry, index) => (
          <div key={`${entry.ts}-${index}`} className={`log-${entry.level}`}>
            {entry.ts.slice(11, 19)} {entry.level.toUpperCase().padEnd(5)} {entry.message}
          </div>
        ))}
        <div ref={bottom} />
      </pre>
    </>
  );
}
