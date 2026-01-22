'use client'

import { useState, useEffect } from 'react'
import { ImageWithFallback } from './figma/ImageWithFallback'

export function Services() {
  const [isVisible, setIsVisible] = useState(false)
  const [hoveredPhoto, setHoveredPhoto] = useState<string | null>(null)

  const services = [
    {
      id: 'campaigns',
      title: "Campaign & Ad Content",
      description: "Multi-platform video campaigns ready for every channel—YouTube, TikTok, Instagram, and beyond.",
      color: 'accent-emerald',
      rotation: 'rotate-2',
      image: 'https://images.unsplash.com/photo-1611224923853-80b023f02d71?w=400&h=300&fit=crop&auto=format'
    },
    {
      id: 'brand-films',
      title: "Brand Films & Stories", 
      description: "Cinematic brand videos that capture your essence and connect with audiences on an emotional level.",
      color: 'accent-blue',
      rotation: '-rotate-1',
      image: 'https://images.unsplash.com/photo-1440404653325-ab127d49abc1?w=400&h=300&fit=crop&auto=format'
    },
    {
      id: 'trailers',
      title: "Trailers & Promos",
      description: "High-impact teasers that hook viewers instantly—perfect for launches, events, and announcements.",
      color: 'accent-purple',
      rotation: 'rotate-1',
      image: 'https://images.unsplash.com/photo-1518676590629-3dcbd9c5a5c9?w=400&h=300&fit=crop&auto=format'
    },
    {
      id: 'short-films',
      title: "Short-Form Films",
      description: "Festival-ready mini-movies up to 5 minutes—ideal for investors, events, and premium content.",
      color: 'accent-emerald',
      rotation: '-rotate-2',
      image: 'https://images.unsplash.com/photo-1574267432553-4b4628081c31?w=400&h=300&fit=crop&auto=format'
    },
    {
      id: 'animation',
      title: "Animation & Motion",
      description: "Stylized animated content that explains complex ideas without needing live actors.",
      color: 'accent-blue',
      rotation: 'rotate-3',
      image: 'https://images.unsplash.com/photo-1626785774573-4b799315345d?w=400&h=300&fit=crop&auto=format'
    },
    {
      id: 'social',
      title: "Social Content",
      description: "Thumb-stopping vertical videos delivered in batches to keep your feed consistently engaging.",
      color: 'accent-purple',
      rotation: '-rotate-1',
      image: 'https://images.unsplash.com/photo-1562577309-4932fdd64cd1?w=400&h=300&fit=crop&auto=format'
    }
  ]

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 300)
    return () => clearTimeout(timer)
  }, [])

  return (
    <section id="services" className="relative py-20" style={{
      background: 'linear-gradient(135deg, #2d1810 0%, #1a0f08 30%, #0f0704 60%, #1a0f08 100%)',
      overflow: 'visible'
    }}>
      
      {/* Photo Lab Background Elements */}
      <div className="absolute inset-0">
        {/* Darkroom ambient lighting effect */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-red-900/20 rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-1/4 w-64 h-64 bg-amber-900/15 rounded-full blur-2xl" />
        
        {/* Equipment silhouettes */}
        <div className="absolute bottom-8 left-8 w-16 h-24 bg-black/40 rounded-t-lg transform rotate-3" />
        <div className="absolute bottom-8 right-8 w-12 h-20 bg-black/30 rounded-lg transform -rotate-2" />
        
        {/* Chemical trays suggestion */}
        <div className="absolute bottom-12 left-1/4 w-32 h-8 bg-black/30 rounded-lg transform rotate-1" />
        <div className="absolute bottom-12 right-1/4 w-28 h-6 bg-black/25 rounded-lg transform -rotate-1" />
      </div>

      <div className="container mx-auto px-6 sm:px-8 lg:px-12 relative z-10">
        
        {/* Header */}
        <div className="text-center mb-16">
          <div className={`inline-flex items-center gap-3 mb-6 transform transition-all duration-1000 ${
            isVisible ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
          }`}>
            <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
            <span className="text-sm font-semibold text-amber-200/80">
              Fresh from the Darkroom
            </span>
            <div className="w-3 h-3 bg-amber-500 rounded-full animate-pulse" />
          </div>
          
          <h2 className={`text-5xl sm:text-6xl lg:text-7xl font-black leading-tight mb-6 text-amber-100 transform transition-all duration-1000 delay-200 ${
            isVisible ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'
          }`}>
            What We Develop
          </h2>
          
          <p className={`text-xl text-amber-200/90 leading-relaxed max-w-3xl mx-auto transform transition-all duration-1000 delay-400 ${
            isVisible ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
          }`}>
            Developed with precision, delivered with passion
          </p>
        </div>

        {/* Photo Lab Clotheslines */}
        <div className={`w-full transform transition-all duration-1000 delay-600 ${
          isVisible ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'
        }`} style={{ overflow: 'visible' }}>
          
          {/* First Clothesline - Top Row */}
          <div className="relative mb-24" style={{ overflow: 'visible' }}>
            {/* Ultra-Realistic Rope - Full width from edge to edge */}
            <div className="absolute top-8 left-0 right-0 h-4 rope-sway">
              {/* Rope base with realistic hemp coloring */}
              <div className="w-full h-full bg-gradient-to-b from-yellow-800 via-amber-900 to-yellow-900 rounded-full shadow-lg" />
              
              {/* Primary twisted fiber strands */}
              <div className="absolute inset-0 opacity-90 rounded-full" 
                   style={{
                     backgroundImage: `
                       repeating-conic-gradient(
                         from 0deg at 50% 50%,
                         #8B4513 0deg,
                         #A0522D 30deg,
                         #654321 60deg,
                         #8B4513 90deg,
                         #A0522D 120deg,
                         #654321 150deg,
                         #8B4513 180deg,
                         #A0522D 210deg,
                         #654321 240deg,
                         #8B4513 270deg,
                         #A0522D 300deg,
                         #654321 330deg
                       ),
                       repeating-linear-gradient(
                         45deg,
                         rgba(139,69,19,0.6) 0px,
                         rgba(160,82,45,0.4) 2px,
                         transparent 4px,
                         rgba(101,67,33,0.6) 6px,
                         transparent 8px
                       ),
                       repeating-linear-gradient(
                         -45deg,
                         rgba(160,82,45,0.5) 0px,
                         transparent 2px,
                         rgba(139,69,19,0.6) 4px,
                         rgba(101,67,33,0.4) 6px,
                         transparent 8px
                       )
                     `,
                     backgroundSize: '100% 100%, 12px 100%, 14px 100%'
                   }} />
              
              {/* Individual fiber highlights */}
              <div className="absolute inset-0 opacity-60 rounded-full" 
                   style={{
                     backgroundImage: `
                       radial-gradient(ellipse at 20% 30%, rgba(218,165,32,0.8) 0%, transparent 30%),
                       radial-gradient(ellipse at 60% 20%, rgba(205,133,63,0.6) 0%, transparent 25%),
                       radial-gradient(ellipse at 80% 70%, rgba(210,180,140,0.7) 0%, transparent 35%),
                       radial-gradient(ellipse at 40% 80%, rgba(222,184,135,0.5) 0%, transparent 30%)
                     `
                   }} />
              
              {/* Rope dimensional highlighting */}
              <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-transparent via-yellow-700 to-transparent rounded-full opacity-80" />
              
              {/* Deep rope shadow for realism */}
              <div className="absolute top-2 left-0 right-0 h-2 bg-gradient-to-r from-transparent via-yellow-950 to-transparent rounded-full opacity-70" />
              
              {/* Multi-layer drop shadow */}
              <div className="absolute -bottom-3 left-0 right-0 h-4 bg-black/30 rounded-full blur-xl" />
              <div className="absolute -bottom-1 left-0 right-0 h-2 bg-black/50 rounded-full blur-sm" />
            </div>
            
            {/* Heavy-duty wall anchor points */}
            <div className="absolute left-0 sm:-left-10 top-4 w-10 h-10 bg-gradient-to-br from-gray-500 to-gray-800 rounded-full shadow-xl border border-gray-400">
              <div className="absolute top-1.5 left-1.5 w-3 h-3 bg-gray-300 rounded-full opacity-80" />
              <div className="absolute bottom-1.5 right-1.5 w-1.5 h-1.5 bg-black/60 rounded-full" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-gray-900 rounded-full" />
            </div>
            <div className="absolute right-0 sm:-right-10 top-4 w-10 h-10 bg-gradient-to-br from-gray-500 to-gray-800 rounded-full shadow-xl border border-gray-400">
              <div className="absolute top-1.5 left-1.5 w-3 h-3 bg-gray-300 rounded-full opacity-80" />
              <div className="absolute bottom-1.5 right-1.5 w-1.5 h-1.5 bg-black/60 rounded-full" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-gray-900 rounded-full" />
            </div>
            
            {/* Photos hanging from first line */}
            <div className="flex flex-wrap justify-center gap-4 sm:gap-8 lg:gap-16 pt-20 max-w-7xl mx-auto px-4">
              {services.slice(0, 3).map((service, index) => (
                <div
                  key={service.id}
                  className={`transform transition-all duration-700 ${
                    hoveredPhoto === service.id ? 'scale-105 -translate-y-2' : 'scale-100'
                  } ${
                     index === 0 ? 'photo-sway-1' : index === 1 ? 'photo-sway-2' : 'photo-sway-3'
                  }`}
                   style={{
                     transitionDelay: `${index * 200 + 800}ms`
                   }}
                  onMouseEnter={() => setHoveredPhoto(service.id)}
                  onMouseLeave={() => setHoveredPhoto(null)}
                >
                  {/* Simple Realistic Wooden Clothespin */}
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 z-20">
                    {/* Clothespin body */}
                    <div className="relative w-5 h-10">
                      {/* Left wooden half */}
                      <div className="absolute left-0 top-0 w-2.5 h-10 bg-gradient-to-r from-yellow-200 to-orange-200 rounded-l-md shadow-md border-r border-orange-300/30">
                        {/* Simple wood grain */}
                        <div className="absolute inset-0 opacity-30 rounded-l-md"
                             style={{
                               backgroundImage: `
                                 linear-gradient(0deg, 
                                   rgba(139,69,19,0.2) 0%, 
                                   transparent 20%, 
                                   rgba(160,82,45,0.15) 40%, 
                                   transparent 60%, 
                                   rgba(139,69,19,0.2) 80%, 
                                   transparent 100%
                                 )
                               `,
                               backgroundSize: '100% 8px'
                             }} />
                      </div>
                      
                      {/* Right wooden half */}
                      <div className="absolute right-0 top-0 w-2.5 h-10 bg-gradient-to-l from-yellow-200 to-orange-200 rounded-r-md shadow-md border-l border-orange-300/30">
                        {/* Simple wood grain */}
                        <div className="absolute inset-0 opacity-30 rounded-r-md"
                             style={{
                               backgroundImage: `
                                 linear-gradient(0deg, 
                                   rgba(139,69,19,0.2) 0%, 
                                   transparent 20%, 
                                   rgba(160,82,45,0.15) 40%, 
                                   transparent 60%, 
                                   rgba(139,69,19,0.2) 80%, 
                                   transparent 100%
                                 )
                               `,
                               backgroundSize: '100% 8px'
                             }} />
                      </div>
                      
                      {/* Simple metal spring */}
                      <div className="absolute top-2 left-1/2 -translate-x-1/2 w-4 h-2 bg-gradient-to-b from-gray-300 to-gray-500 rounded-sm shadow-sm">
                        {/* Spring coils */}
                        <div className="absolute top-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 bg-gray-400 rounded-full" />
                        <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 bg-gray-400 rounded-full" />
                      </div>
                      
                      {/* Clothespin tips */}
                      <div className="absolute bottom-0 left-0 w-2.5 h-2 bg-gradient-to-b from-orange-200 to-orange-300 rounded-b-md" />
                      <div className="absolute bottom-0 right-0 w-2.5 h-2 bg-gradient-to-b from-orange-200 to-orange-300 rounded-b-md" />
                    </div>
                  </div>
                  
                  {/* Photo */}
                  <div className="relative bg-white p-4 pb-8 shadow-2xl cursor-pointer w-[260px] sm:w-[280px] max-w-[90vw]"
                       style={{
                         filter: hoveredPhoto === service.id ? 'brightness(1.1) contrast(1.05)' : 'brightness(1) contrast(0.95)',
                         boxShadow: `
                           0 20px 40px rgba(0,0,0,0.6),
                           0 8px 16px rgba(0,0,0,0.4),
                           inset 0 1px 0 rgba(255,255,255,0.9)
                         `
                       }}>
                    
                    {/* Photo Area */}
                    <div className="h-48 mb-6 rounded-sm relative">
                      <ImageWithFallback
                        src={service.image}
                        alt={service.title}
                        className="w-full h-full object-cover rounded-sm"
                        style={{
                          filter: 'sepia(15%) saturate(85%) brightness(90%) contrast(1.1)'
                        }}
                      />
                      
                      {/* Darkroom development effects */}
                      <div className="absolute inset-0 bg-red-900/5 rounded-sm" />
                      <div className="absolute inset-0 opacity-[0.03] rounded-sm" 
                           style={{
                             backgroundImage: `radial-gradient(circle at 1px 1px, rgba(139,69,19,0.8) 1px, transparent 0)`,
                             backgroundSize: '3px 3px'
                           }} />
                      
                      {/* Corner curl effect */}
                      <div className="absolute top-2 right-2 w-6 h-6 bg-white/20 rounded-full transform rotate-45" />
                    </div>
                    
                    {/* Text */}
                    <div className="relative">
                      <h3 className="font-black text-lg text-gray-800 mb-3 leading-tight">
                        {service.title}
                      </h3>
                      
                      <p className="text-sm text-gray-600 leading-relaxed">
                        {service.description}
                      </p>
                    </div>
                    
                    {/* Vintage photo aging effects */}
                    <div className="absolute top-3 right-3 w-4 h-4 bg-yellow-100/30 rounded-full" />
                    <div className="absolute bottom-8 left-3 w-2 h-8 bg-yellow-100/20 rounded-full transform rotate-15" />
                    
                    {/* Developer stamp */}
                    <div className="absolute bottom-2 right-2 text-xs text-gray-400 font-mono opacity-60">
                      MOJJU LAB
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Second Clothesline - Bottom Row */}
          <div className="relative" style={{ overflow: 'visible' }}>
            {/* Ultra-Realistic Rope - Full width from edge to edge */}
            <div className="absolute top-8 left-0 right-0 h-4 rope-sway" style={{ animationDelay: '2s' }}>
              {/* Rope base with realistic hemp coloring */}
              <div className="w-full h-full bg-gradient-to-b from-yellow-800 via-amber-900 to-yellow-900 rounded-full shadow-lg" />
              
              {/* Primary twisted fiber strands */}
              <div className="absolute inset-0 opacity-90 rounded-full" 
                   style={{
                     backgroundImage: `
                       repeating-conic-gradient(
                         from 0deg at 50% 50%,
                         #8B4513 0deg,
                         #A0522D 30deg,
                         #654321 60deg,
                         #8B4513 90deg,
                         #A0522D 120deg,
                         #654321 150deg,
                         #8B4513 180deg,
                         #A0522D 210deg,
                         #654321 240deg,
                         #8B4513 270deg,
                         #A0522D 300deg,
                         #654321 330deg
                       ),
                       repeating-linear-gradient(
                         45deg,
                         rgba(139,69,19,0.6) 0px,
                         rgba(160,82,45,0.4) 2px,
                         transparent 4px,
                         rgba(101,67,33,0.6) 6px,
                         transparent 8px
                       ),
                       repeating-linear-gradient(
                         -45deg,
                         rgba(160,82,45,0.5) 0px,
                         transparent 2px,
                         rgba(139,69,19,0.6) 4px,
                         rgba(101,67,33,0.4) 6px,
                         transparent 8px
                       )
                     `,
                     backgroundSize: '100% 100%, 12px 100%, 14px 100%'
                   }} />
              
              {/* Individual fiber highlights */}
              <div className="absolute inset-0 opacity-60 rounded-full" 
                   style={{
                     backgroundImage: `
                       radial-gradient(ellipse at 20% 30%, rgba(218,165,32,0.8) 0%, transparent 30%),
                       radial-gradient(ellipse at 60% 20%, rgba(205,133,63,0.6) 0%, transparent 25%),
                       radial-gradient(ellipse at 80% 70%, rgba(210,180,140,0.7) 0%, transparent 35%),
                       radial-gradient(ellipse at 40% 80%, rgba(222,184,135,0.5) 0%, transparent 30%)
                     `
                   }} />
              
              {/* Rope dimensional highlighting */}
              <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-transparent via-yellow-700 to-transparent rounded-full opacity-80" />
              
              {/* Deep rope shadow for realism */}
              <div className="absolute top-2 left-0 right-0 h-2 bg-gradient-to-r from-transparent via-yellow-950 to-transparent rounded-full opacity-70" />
              
              {/* Multi-layer drop shadow */}
              <div className="absolute -bottom-3 left-0 right-0 h-4 bg-black/30 rounded-full blur-xl" />
              <div className="absolute -bottom-1 left-0 right-0 h-2 bg-black/50 rounded-full blur-sm" />
            </div>
            
            {/* Heavy-duty wall anchor points */}
            <div className="absolute left-0 sm:-left-10 top-4 w-10 h-10 bg-gradient-to-br from-gray-500 to-gray-800 rounded-full shadow-xl border border-gray-400">
              <div className="absolute top-1.5 left-1.5 w-3 h-3 bg-gray-300 rounded-full opacity-80" />
              <div className="absolute bottom-1.5 right-1.5 w-1.5 h-1.5 bg-black/60 rounded-full" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-gray-900 rounded-full" />
            </div>
            <div className="absolute right-0 sm:-right-10 top-4 w-10 h-10 bg-gradient-to-br from-gray-500 to-gray-800 rounded-full shadow-xl border border-gray-400">
              <div className="absolute top-1.5 left-1.5 w-3 h-3 bg-gray-300 rounded-full opacity-80" />
              <div className="absolute bottom-1.5 right-1.5 w-1.5 h-1.5 bg-black/60 rounded-full" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 bg-gray-900 rounded-full" />
            </div>
            
            {/* Photos hanging from second line */}
            <div className="flex flex-wrap justify-center gap-4 sm:gap-8 lg:gap-16 pt-20 max-w-7xl mx-auto px-4">
              {services.slice(3, 6).map((service, index) => (
                <div
                  key={service.id}
                  className={`transform transition-all duration-700 ${
                    hoveredPhoto === service.id ? 'scale-105 -translate-y-2' : 'scale-100'
                  } ${
                     index === 0 ? 'photo-sway-3' : index === 1 ? 'photo-sway-1' : 'photo-sway-2'
                  }`}
                   style={{
                     transitionDelay: `${(index + 3) * 200 + 800}ms`,
                     animationDelay: `${index * 1.5 + 3}s`
                   }}
                  onMouseEnter={() => setHoveredPhoto(service.id)}
                  onMouseLeave={() => setHoveredPhoto(null)}
                >
                  {/* Simple Realistic Wooden Clothespin */}
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 z-20">
                    {/* Clothespin body */}
                    <div className="relative w-5 h-10">
                      {/* Left wooden half */}
                      <div className="absolute left-0 top-0 w-2.5 h-10 bg-gradient-to-r from-yellow-200 to-orange-200 rounded-l-md shadow-md border-r border-orange-300/30">
                        {/* Simple wood grain */}
                        <div className="absolute inset-0 opacity-30 rounded-l-md"
                             style={{
                               backgroundImage: `
                                 linear-gradient(0deg, 
                                   rgba(139,69,19,0.2) 0%, 
                                   transparent 20%, 
                                   rgba(160,82,45,0.15) 40%, 
                                   transparent 60%, 
                                   rgba(139,69,19,0.2) 80%, 
                                   transparent 100%
                                 )
                               `,
                               backgroundSize: '100% 8px'
                             }} />
                      </div>
                      
                      {/* Right wooden half */}
                      <div className="absolute right-0 top-0 w-2.5 h-10 bg-gradient-to-l from-yellow-200 to-orange-200 rounded-r-md shadow-md border-l border-orange-300/30">
                        {/* Simple wood grain */}
                        <div className="absolute inset-0 opacity-30 rounded-r-md"
                             style={{
                               backgroundImage: `
                                 linear-gradient(0deg, 
                                   rgba(139,69,19,0.2) 0%, 
                                   transparent 20%, 
                                   rgba(160,82,45,0.15) 40%, 
                                   transparent 60%, 
                                   rgba(139,69,19,0.2) 80%, 
                                   transparent 100%
                                 )
                               `,
                               backgroundSize: '100% 8px'
                             }} />
                      </div>
                      
                      {/* Simple metal spring */}
                      <div className="absolute top-2 left-1/2 -translate-x-1/2 w-4 h-2 bg-gradient-to-b from-gray-300 to-gray-500 rounded-sm shadow-sm">
                        {/* Spring coils */}
                        <div className="absolute top-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 bg-gray-400 rounded-full" />
                        <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-3 h-0.5 bg-gray-400 rounded-full" />
                      </div>
                      
                      {/* Clothespin tips */}
                      <div className="absolute bottom-0 left-0 w-2.5 h-2 bg-gradient-to-b from-orange-200 to-orange-300 rounded-b-md" />
                      <div className="absolute bottom-0 right-0 w-2.5 h-2 bg-gradient-to-b from-orange-200 to-orange-300 rounded-b-md" />
                    </div>
                  </div>
                  
                  {/* Photo - Same structure as above */}
                  <div className="relative bg-white p-4 pb-8 shadow-2xl cursor-pointer w-[260px] sm:w-[280px] max-w-[90vw]"
                       style={{
                         filter: hoveredPhoto === service.id ? 'brightness(1.1) contrast(1.05)' : 'brightness(1) contrast(0.95)',
                         boxShadow: `
                           0 20px 40px rgba(0,0,0,0.6),
                           0 8px 16px rgba(0,0,0,0.4),
                           inset 0 1px 0 rgba(255,255,255,0.9)
                         `
                       }}>
                    
                    <div className="h-48 mb-6 rounded-sm relative">
                      <ImageWithFallback
                        src={service.image}
                        alt={service.title}
                        className="w-full h-full object-cover rounded-sm"
                        style={{
                          filter: 'sepia(15%) saturate(85%) brightness(90%) contrast(1.1)'
                        }}
                      />
                      <div className="absolute inset-0 bg-red-900/5 rounded-sm" />
                      <div className="absolute inset-0 opacity-[0.03] rounded-sm" 
                           style={{
                             backgroundImage: `radial-gradient(circle at 1px 1px, rgba(139,69,19,0.8) 1px, transparent 0)`,
                             backgroundSize: '3px 3px'
                           }} />
                      <div className="absolute top-2 right-2 w-6 h-6 bg-white/20 rounded-full transform rotate-45" />
                    </div>
                    
                    <div className="relative">
                      <h3 className="font-black text-lg text-gray-800 mb-3 leading-tight">
                        {service.title}
                      </h3>
                      
                      <p className="text-sm text-gray-600 leading-relaxed">
                        {service.description}
                      </p>
                    </div>
                    
                    <div className="absolute top-3 right-3 w-4 h-4 bg-yellow-100/30 rounded-full" />
                    <div className="absolute bottom-8 left-3 w-2 h-8 bg-yellow-100/20 rounded-full transform rotate-15" />
                    
                    <div className="absolute bottom-2 right-2 text-xs text-gray-400 font-mono opacity-60">
                      MOJJU LAB
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Darkroom atmosphere note */}
          <div className="mt-16 text-center">
            <p className="text-sm text-amber-200/70 leading-relaxed max-w-2xl mx-auto">
              Each piece is carefully developed in our creative darkroom, ensuring every detail captures the essence of your vision with precision and artistic flair.
            </p>
          </div>
        </div>
      </div>
      
    </section>
  )
}