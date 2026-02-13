'use client'

import { useEffect, useRef } from 'react'

interface Star {
  x: number
  y: number
  size: number
  speed: number
  opacity: number
  twinkleSpeed: number
  twinklePhase: number
  color: string
}

interface ShootingStar {
  x: number
  y: number
  length: number
  speed: number
  angle: number
  opacity: number
  life: number
  maxLife: number
}

const STAR_COLORS = [
  'rgba(0, 240, 255, ',    // cyan
  'rgba(124, 58, 237, ',   // purple
  'rgba(244, 114, 182, ',  // pink
  'rgba(255, 255, 255, ',  // white
  'rgba(200, 200, 255, ',  // blue-white
]

export function AnimatedStarfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationId: number
    let stars: Star[] = []
    let shootingStars: ShootingStar[] = []

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      initStars()
    }

    const initStars = () => {
      const count = Math.min(Math.floor((canvas.width * canvas.height) / 3000), 400)
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: Math.random() * 2.5 + 0.3,
        speed: Math.random() * 0.15 + 0.02,
        opacity: Math.random() * 0.8 + 0.2,
        twinkleSpeed: Math.random() * 0.03 + 0.01,
        twinklePhase: Math.random() * Math.PI * 2,
        color: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
      }))
    }

    const spawnShootingStar = () => {
      if (shootingStars.length < 2 && Math.random() < 0.008) {
        shootingStars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height * 0.5,
          length: Math.random() * 120 + 60,
          speed: Math.random() * 8 + 6,
          angle: (Math.random() * 30 + 15) * (Math.PI / 180),
          opacity: 1,
          life: 0,
          maxLife: Math.random() * 40 + 30,
        })
      }
    }

    let time = 0
    const animate = () => {
      time += 1
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Draw nebula glow layers
      const gradient1 = ctx.createRadialGradient(
        canvas.width * 0.3, canvas.height * 0.4, 0,
        canvas.width * 0.3, canvas.height * 0.4, canvas.width * 0.5
      )
      gradient1.addColorStop(0, 'rgba(124, 58, 237, 0.06)')
      gradient1.addColorStop(0.5, 'rgba(124, 58, 237, 0.02)')
      gradient1.addColorStop(1, 'transparent')
      ctx.fillStyle = gradient1
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      const gradient2 = ctx.createRadialGradient(
        canvas.width * 0.7, canvas.height * 0.6, 0,
        canvas.width * 0.7, canvas.height * 0.6, canvas.width * 0.4
      )
      gradient2.addColorStop(0, 'rgba(0, 240, 255, 0.04)')
      gradient2.addColorStop(0.5, 'rgba(0, 240, 255, 0.01)')
      gradient2.addColorStop(1, 'transparent')
      ctx.fillStyle = gradient2
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // Draw stars
      for (const star of stars) {
        star.twinklePhase += star.twinkleSpeed
        const twinkle = Math.sin(star.twinklePhase) * 0.4 + 0.6
        const finalOpacity = star.opacity * twinkle
        
        // Slow drift
        star.y -= star.speed
        star.x += Math.sin(time * 0.001 + star.twinklePhase) * 0.1
        
        if (star.y < -5) {
          star.y = canvas.height + 5
          star.x = Math.random() * canvas.width
        }
        
        // Glow
        if (star.size > 1.2) {
          const glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.size * 4)
          glow.addColorStop(0, star.color + (finalOpacity * 0.3) + ')')
          glow.addColorStop(1, star.color + '0)')
          ctx.fillStyle = glow
          ctx.beginPath()
          ctx.arc(star.x, star.y, star.size * 4, 0, Math.PI * 2)
          ctx.fill()
        }

        // Star core
        ctx.fillStyle = star.color + finalOpacity + ')'
        ctx.beginPath()
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2)
        ctx.fill()
      }

      // Shooting stars
      spawnShootingStar()
      shootingStars = shootingStars.filter(s => {
        s.life += 1
        s.x += Math.cos(s.angle) * s.speed
        s.y += Math.sin(s.angle) * s.speed
        s.opacity = 1 - (s.life / s.maxLife)

        if (s.opacity <= 0) return false

        const tailX = s.x - Math.cos(s.angle) * s.length
        const tailY = s.y - Math.sin(s.angle) * s.length

        const gradient = ctx.createLinearGradient(tailX, tailY, s.x, s.y)
        gradient.addColorStop(0, 'rgba(0, 240, 255, 0)')
        gradient.addColorStop(0.7, `rgba(0, 240, 255, ${s.opacity * 0.5})`)
        gradient.addColorStop(1, `rgba(255, 255, 255, ${s.opacity})`)

        ctx.strokeStyle = gradient
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(tailX, tailY)
        ctx.lineTo(s.x, s.y)
        ctx.stroke()

        // Head glow
        const headGlow = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 8)
        headGlow.addColorStop(0, `rgba(255, 255, 255, ${s.opacity})`)
        headGlow.addColorStop(0.5, `rgba(0, 240, 255, ${s.opacity * 0.5})`)
        headGlow.addColorStop(1, 'rgba(0, 240, 255, 0)')
        ctx.fillStyle = headGlow
        ctx.beginPath()
        ctx.arc(s.x, s.y, 8, 0, Math.PI * 2)
        ctx.fill()

        return true
      })

      animationId = requestAnimationFrame(animate)
    }

    resize()
    window.addEventListener('resize', resize)
    animate()

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(animationId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ background: 'transparent' }}
    />
  )
}
