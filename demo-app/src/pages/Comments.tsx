import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { Comment } from '../services/api';
import './Comments.css';

export function Comments() {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchComments = async () => {
      try {
        setLoading(true);
        const data = await api.getComments();
        setComments(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load comments');
      } finally {
        setLoading(false);
      }
    };

    fetchComments();
  }, []);

  if (loading) {
    return <div className="loading">Loading comments...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  return (
    <div className="comments-page">
      <div className="page-container">
        <h1>Comments</h1>
        <p className="comments-count">Total: {comments.length} comments</p>
        <div className="comments-list">
          {comments.map((comment) => (
            <div key={comment.id} className="comment-card">
              <div className="comment-header">
                <h3>{comment.name}</h3>
                <span className="comment-email">{comment.email}</span>
              </div>
              <p className="comment-body">{comment.body}</p>
              <div className="comment-footer">
                <span>Post ID: {comment.postId}</span>
                <span>Comment ID: {comment.id}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
