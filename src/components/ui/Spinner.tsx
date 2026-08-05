'use client';

import clsx from 'clsx';
import { motion } from 'motion/react';

const SPOKES = [0, 1, 2, 3, 4, 5, 6, 7];

/** Eight discrete steps per revolution - the macOS spinner does not glide. */
const step8 = (t: number) => Math.floor(t * 8) / 8;

export interface SpinnerProps {
  /** Edge length in px. 12 inside an sm control, 14 default, 16+ standalone. */
  size?: number;
  className?: string;
  label?: string;
}

export function Spinner({ size = 14, className, label = 'Working' }: SpinnerProps) {
  const spokeW = Math.max(1, Math.round(size * 0.12));
  const spokeH = size * 0.3;

  return (
    <motion.span
      role="progressbar"
      aria-label={label}
      aria-busy
      className={clsx('relative inline-block shrink-0 text-label-secondary', className)}
      style={{ width: size, height: size }}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.8, ease: step8 }}
    >
      {SPOKES.map((i) => (
        <span
          key={i}
          aria-hidden
          className="absolute left-1/2 top-0 block rounded-full bg-current"
          style={{
            width: spokeW,
            height: spokeH,
            marginLeft: -spokeW / 2,
            transformOrigin: `50% ${size / 2}px`,
            transform: `rotate(${i * 45}deg)`,
            opacity: 0.18 + (i / 7) * 0.72,
          }}
        />
      ))}
    </motion.span>
  );
}
