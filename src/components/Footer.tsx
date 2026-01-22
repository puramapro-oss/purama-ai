'use client'

export function Footer() {
  const aiTools = [
    'Runway Gen-4',
    'Kling 2', 
    'Veo 3',
    'Higgsfield AI',
    'Hailuo Minimax 2',
    'Midjourney',
    'Leonardo AI',
    'Krea AI',
    'Runway',
    'Suno AI',
    'ElevenLabs'
  ]

  return (
    <footer className="relative py-20 bg-foreground text-background">
      <div className="container mx-auto px-6 sm:px-8 lg:px-12">
        <div className="grid grid-cols-12 gap-12">
          {/* Logo and Description */}
          <div className="col-span-12 md:col-span-4">
            <div>
              <div className="font-bagel text-background text-3xl tracking-wider mb-4">
                MOJJU
              </div>
              <p className="text-background/70 leading-relaxed mb-6">
                Revolutionizing video production with intelligent AI that understands 
                creativity, storytelling, and human emotion.
              </p>
              {/* Social Media Icons */}
              <div className="flex items-center space-x-6">
                {/* X (Twitter) */}
                <a
                  href="https://x.com/Mojjuai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:scale-110 gentle-animation cursor-pointer"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#E5E7EB">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                  </svg>
                </a>

                {/* TikTok */}
                <a
                  href="https://www.tiktok.com/@mojju.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:scale-110 gentle-animation cursor-pointer"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#FF0050">
                    <path d="M19.321 5.562a5.122 5.122 0 0 1-.443-.258 6.228 6.228 0 0 1-1.137-.966c-.849-.936-1.315-2.117-1.315-3.338h-3.357v14.826c0 1.543-1.252 2.795-2.795 2.795s-2.795-1.252-2.795-2.795 1.252-2.795 2.795-2.795c.293 0 .576.045.843.13V9.804a6.67 6.67 0 0 0-.843-.054c-3.683 0-6.674 2.99-6.674 6.674s2.99 6.674 6.674 6.674 6.674-2.99 6.674-6.674V9.696a9.577 9.577 0 0 0 5.588 1.786V7.627c-1.319 0-2.54-.529-3.42-1.394a4.902 4.902 0 0 1-1.294-2.671z"/>
                  </svg>
                </a>

                {/* Instagram */}
                <a
                  href="https://www.instagram.com/mojju.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:scale-110 gentle-animation cursor-pointer"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="url(#instagram-gradient)">
                    <defs>
                      <linearGradient id="instagram-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#833AB4"/>
                        <stop offset="50%" stopColor="#E1306C"/>
                        <stop offset="100%" stopColor="#F56040"/>
                      </linearGradient>
                    </defs>
                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                  </svg>
                </a>

                {/* LinkedIn */}
                <a
                  href="https://linkedin.com/company/mojju"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:scale-110 gentle-animation cursor-pointer"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#0077B5">
                    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                  </svg>
                </a>
              </div>
            </div>
          </div>

          {/* Tools We Use Section */}
          <div className="col-span-12 md:col-span-8">
            <div>
              <h4 className="font-black text-2xl text-background mb-4">TOOLS WE USE</h4>
              
              {/* AI Tools Description */}
              <p className="text-background/70 text-base mb-8 leading-relaxed">
                We leverage the latest AI technology to deliver cutting-edge video production. 
                Our toolkit combines the best generative AI models for video, audio, and visual content creation.
              </p>
              
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {aiTools.map((tool, index) => (
                  <div
                    key={tool}
                    className="text-background/80 hover:text-background gentle-animation text-sm font-medium"
                  >
                    {tool}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar - Simplified */}
        <div className="border-t border-background/20 pt-8 mt-16">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="text-sm text-background/70 mb-4 md:mb-0">
              © 2025 MOJJU. All rights reserved.
            </div>
            <div className="text-sm text-background/70">
              2847 HIGHLAND AVE. SUITE 310 BIRMINGHAM 35205, AL, USA
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}