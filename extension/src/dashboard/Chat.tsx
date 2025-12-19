import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage } from '../shared/types';
import { api } from '../shared/api';

interface ChatProps {
  backendConnected: boolean;
}

export function Chat({ backendConnected }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Hi! I\'m your InstaMap AI assistant. Ask me anything about your saved posts! For example:\n\n• "Show me food posts from Japan"\n• "Find posts about hiking"\n• "What are my most common post categories?"',
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    if (!backendConnected) {
      // Offline mode response
      const offlineResponse: ChatMessage = {
        id: `assistant_${Date.now()}`,
        role: 'assistant',
        content: 'I\'m currently in offline mode. Please make sure the backend server is running to use AI features.\n\nTo start the backend:\n```\ncd backend && npm run dev\n```',
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, offlineResponse]);
      setIsLoading(false);
      return;
    }

    try {
      const response = await api.chat(userMessage.content);
      setMessages(prev => [...prev, response]);
    } catch (error) {
      const errorResponse: ChatMessage = {
        id: `error_${Date.now()}`,
        role: 'assistant',
        content: 'Sorry, I encountered an error. Please try again later.',
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, errorResponse]);
    }

    setIsLoading(false);
  }

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.map((message) => (
          <div 
            key={message.id} 
            className={`chat-message ${message.role}`}
          >
            <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
            {message.relatedPosts && message.relatedPosts.length > 0 && (
              <div style={{ 
                marginTop: '12px', 
                display: 'grid', 
                gridTemplateColumns: 'repeat(3, 1fr)', 
                gap: '8px' 
              }}>
                {message.relatedPosts.map(post => (
                  <img 
                    key={post.id}
                    src={post.thumbnailUrl || post.imageUrl}
                    alt=""
                    style={{ 
                      width: '100%', 
                      aspectRatio: '1', 
                      objectFit: 'cover', 
                      borderRadius: '8px',
                      cursor: 'pointer',
                    }}
                    onClick={() => window.open(`https://instagram.com/p/${post.instagramId}`, '_blank')}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        
        {isLoading && (
          <div className="chat-message assistant">
            <div style={{ display: 'flex', gap: '4px' }}>
              <span style={{ animation: 'pulse 1s infinite' }}>●</span>
              <span style={{ animation: 'pulse 1s infinite 0.2s' }}>●</span>
              <span style={{ animation: 'pulse 1s infinite 0.4s' }}>●</span>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="chat-input-container">
        <input
          type="text"
          className="chat-input"
          placeholder={backendConnected 
            ? "Ask about your saved posts..." 
            : "Backend offline - start server to chat"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isLoading}
        />
        <button 
          type="submit" 
          className="chat-send"
          disabled={isLoading || !input.trim()}
        >
          ➤
        </button>
      </form>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
