import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage } from '../shared/types';
import { api } from '../shared/api';

// Minimal markdown renderer: bold, italic, inline code, headers, bullet lists
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      result.push(<ul key={`ul-${result.length}`} style={{ margin: '4px 0', paddingLeft: '20px' }}>{listItems}</ul>);
      listItems = [];
    }
  };

  const parseInline = (s: string, key: string): React.ReactNode => {
    // Bold + italic combined: ***text***
    // Bold: **text**, Italic: *text*, Inline code: `text`
    const parts = s.split(/(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
    return (
      <React.Fragment key={key}>
        {parts.map((part, i) => {
          if (part.startsWith('***') && part.endsWith('***')) return <strong key={i}><em>{part.slice(3, -3)}</em></strong>;
          if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
          if (part.startsWith('*') && part.endsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
          if (part.startsWith('`') && part.endsWith('`')) return <code key={i} style={{ background: 'rgba(0,0,0,0.08)', padding: '1px 4px', borderRadius: '3px', fontFamily: 'monospace', fontSize: '0.9em' }}>{part.slice(1, -1)}</code>;
          return part;
        })}
      </React.Fragment>
    );
  };

  lines.forEach((line, i) => {
    const key = String(i);
    if (/^#{1,3}\s/.test(line)) {
      flushList();
      const content = line.replace(/^#{1,3}\s/, '');
      result.push(<strong key={key} style={{ display: 'block', marginTop: '6px' }}>{parseInline(content, key + 'h')}</strong>);
    } else if (/^[-*•]\s/.test(line)) {
      listItems.push(<li key={key}>{parseInline(line.replace(/^[-*•]\s/, ''), key + 'li')}</li>);
    } else if (line.trim() === '') {
      flushList();
      if (result.length > 0) result.push(<br key={key} />);
    } else {
      flushList();
      result.push(<span key={key} style={{ display: 'block' }}>{parseInline(line, key + 'p')}</span>);
    }
  });
  flushList();
  return result;
}

interface ChatProps {
  backendConnected: boolean;
  conversationId?: string | null;
  onConversationStart: (id: string, title: string) => void;
}

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: 'Hi! I\'m your InstaMap AI assistant. Ask me anything about your saved posts! For example:\n\n• "Show me food posts from Japan"\n• "Find posts about hiking"\n• "What are my most common post categories?"',
  timestamp: new Date().toISOString(),
};

export function Chat({ backendConnected, conversationId, onConversationStart }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeConversationId = useRef<string | null>(conversationId ?? null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load conversation history when conversationId changes
  useEffect(() => {
    activeConversationId.current = conversationId ?? null;

    if (!conversationId) {
      setMessages([WELCOME_MESSAGE]);
      return;
    }

    setIsLoadingHistory(true);
    api.getConversation(conversationId)
      .then(conv => {
        setMessages(conv.messages.length > 0 ? conv.messages : [WELCOME_MESSAGE]);
      })
      .catch(() => {
        setMessages([WELCOME_MESSAGE]);
      })
      .finally(() => setIsLoadingHistory(false));
  }, [conversationId]);

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
      const response = await api.chat(userMessage.content, undefined, activeConversationId.current ?? undefined);

      // If this was a new conversation, notify parent with the returned conversationId
      if (!activeConversationId.current) {
        activeConversationId.current = response.conversationId;
        onConversationStart(response.conversationId, userMessage.content.slice(0, 60));
      }

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
        {isLoadingHistory ? (
          <div className="chat-message assistant">
            <div style={{ display: 'flex', gap: '4px' }}>
              <span style={{ animation: 'pulse 1s infinite' }}>●</span>
              <span style={{ animation: 'pulse 1s infinite 0.2s' }}>●</span>
              <span style={{ animation: 'pulse 1s infinite 0.4s' }}>●</span>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`chat-message ${message.role}`}
            >
              <div>{renderMarkdown(message.content)}</div>
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
          ))
        )}

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
          disabled={isLoading || isLoadingHistory}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={isLoading || isLoadingHistory || !input.trim()}
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
