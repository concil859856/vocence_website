import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { dashboardApi, type BlogPost, type RegisteredUser, type DashboardValidator } from '../services/dashboardApi';
import { ShieldOff, Plus, Trash2, Copy, ImagePlus, FileText, Users, ShieldCheck } from 'lucide-react';
import { ADMIN_EMAIL } from '../config';

const ACCENT = '#D1F840';

export function Admin() {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const isAdmin = isAuthenticated && user?.email === ADMIN_EMAIL;

  const [blocklist, setBlocklist] = useState<string[]>([]);
  const [newHotkey, setNewHotkey] = useState('');
  const [blocklistLoading, setBlocklistLoading] = useState(false);
  const [blocklistError, setBlocklistError] = useState<string | null>(null);

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [showPostForm, setShowPostForm] = useState(false);
  const [postForm, setPostForm] = useState({
    title: '',
    excerpt: '',
    category: 'Updates',
    read_time: '5 min read',
    image: '',
    content: '',
    featured: false,
  });
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copiedHotkey, setCopiedHotkey] = useState<string | null>(null);

  const [validators, setValidators] = useState<DashboardValidator[]>([]);
  const [validatorForm, setValidatorForm] = useState({ uid: '', hotkey: '', stake: '0', s3_bucket: '' });
  const [validatorSubmitting, setValidatorSubmitting] = useState(false);
  const [validatorError, setValidatorError] = useState<string | null>(null);

  const [registeredUsers, setRegisteredUsers] = useState<RegisteredUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !user) {
      navigate('/', { replace: true });
      return;
    }
    if (user.email !== ADMIN_EMAIL) {
      navigate('/', { replace: true });
      return;
    }
  }, [isAuthenticated, user, navigate]);

  const loadBlocklist = useCallback(async () => {
    setBlocklistLoading(true);
    setBlocklistError(null);
    try {
      const res = await dashboardApi.getBlocklist();
      setBlocklist(res.hotkeys);
    } catch (e) {
      setBlocklistError(e instanceof Error ? e.message : 'Failed to load blocklist');
      setBlocklist([]);
    } finally {
      setBlocklistLoading(false);
    }
  }, []);

  const loadPosts = useCallback(async () => {
    setPostsLoading(true);
    setPostsError(null);
    try {
      const res = await dashboardApi.getBlogPosts();
      setPosts(res.posts);
    } catch (e) {
      setPostsError(e instanceof Error ? e.message : 'Failed to load posts');
      setPosts([]);
    } finally {
      setPostsLoading(false);
    }
  }, []);

  const loadValidators = useCallback(async () => {
    try {
      const res = await dashboardApi.getValidators();
      setValidators(res.validators);
    } catch {
      setValidators([]);
    }
  }, []);

  const loadRegisteredUsers = useCallback(async () => {
    if (!user?.email) return;
    setUsersLoading(true);
    setUsersError(null);
    try {
      const res = await dashboardApi.getRegisteredUsers(user.email);
      setRegisteredUsers(res.users);
    } catch (e) {
      setUsersError(e instanceof Error ? e.message : 'Failed to load users');
      setRegisteredUsers([]);
    } finally {
      setUsersLoading(false);
    }
  }, [user?.email]);

  useEffect(() => {
    if (isAdmin) {
      loadBlocklist();
      loadPosts();
      loadValidators();
      loadRegisteredUsers();
    }
  }, [isAdmin, loadBlocklist, loadPosts, loadValidators, loadRegisteredUsers]);

  const handleAddHotkey = async (e: React.FormEvent) => {
    e.preventDefault();
    const hotkey = newHotkey.trim();
    if (!hotkey || !user?.email) return;
    setBlocklistError(null);
    try {
      await dashboardApi.addBlocklist(hotkey, user.email);
      setNewHotkey('');
      loadBlocklist();
    } catch (e) {
      setBlocklistError(e instanceof Error ? e.message : 'Failed to add');
    }
  };

  const handleRemoveHotkey = async (hotkey: string) => {
    if (!user?.email) return;
    try {
      await dashboardApi.removeBlocklist(hotkey, user.email);
      loadBlocklist();
    } catch (e) {
      setBlocklistError(e instanceof Error ? e.message : 'Failed to remove');
    }
  };

  const copyHotkey = (hotkey: string) => {
    navigator.clipboard.writeText(hotkey).then(() => {
      setCopiedHotkey(hotkey);
      setTimeout(() => setCopiedHotkey(null), 2000);
    });
  };

  const handleCreatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.email) return;
    let imageUrl = postForm.image;
    if (imageFile) {
      setSubmitting(true);
      try {
        const up = await dashboardApi.uploadBlogImage(imageFile, user.email);
        const dashboardBase = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:34717');
        imageUrl = up.url.startsWith('http') ? up.url : `${dashboardBase}${up.url}`;
      } catch (err) {
        setPostsError(err instanceof Error ? err.message : 'Image upload failed');
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }
    if (!imageUrl) {
      setPostsError('Please upload an image or enter an image URL');
      return;
    }
    setSubmitting(true);
    setPostsError(null);
    try {
      await dashboardApi.createBlogPost(
        { ...postForm, image: imageUrl },
        user.email
      );
      setPostForm({ title: '', excerpt: '', category: 'Updates', read_time: '5 min read', image: '', content: '', featured: false });
      setImageFile(null);
      setShowPostForm(false);
      loadPosts();
    } catch (e) {
      setPostsError(e instanceof Error ? e.message : 'Failed to create post');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeletePost = async (id: string) => {
    if (!user?.email || !confirm('Delete this post?')) return;
    try {
      await dashboardApi.deleteBlogPost(id, user.email);
      loadPosts();
    } catch (e) {
      setPostsError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const handleAddValidator = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.email) return;
    const uid = parseInt(validatorForm.uid, 10);
    if (Number.isNaN(uid) || uid < 0) {
      setValidatorError('UID must be a non-negative number');
      return;
    }
    const hotkey = validatorForm.hotkey.trim();
    if (!hotkey) {
      setValidatorError('Hotkey is required');
      return;
    }
    setValidatorError(null);
    setValidatorSubmitting(true);
    try {
      await dashboardApi.addValidator(
        {
          uid,
          hotkey,
          stake: parseFloat(validatorForm.stake) || 0,
          s3_bucket: validatorForm.s3_bucket.trim() || undefined,
        },
        user.email
      );
      setValidatorForm({ uid: '', hotkey: '', stake: '0', s3_bucket: '' });
      loadValidators();
    } catch (e) {
      setValidatorError(e instanceof Error ? e.message : 'Failed to add validator');
    } finally {
      setValidatorSubmitting(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-16 px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-semibold text-white mb-8">Admin</h1>

        {/* Blacklisted hotkeys */}
        <section className="glass-panel rounded-xl p-6 mb-8">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
            <ShieldOff className="w-5 h-5" style={{ color: ACCENT }} />
            Blacklisted hotkeys
          </h2>
          {blocklistError && <p className="text-sm text-red-400 mb-3">{blocklistError}</p>}
          <form onSubmit={handleAddHotkey} className="flex flex-wrap gap-3 mb-4">
            <input
              type="text"
              value={newHotkey}
              onChange={(e) => setNewHotkey(e.target.value)}
              placeholder="Full hotkey address"
              className="flex-1 min-w-[200px] px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500 focus:border-[#333] focus:outline-none"
            />
            <button type="submit" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-[#07080A] hover:opacity-90 transition-opacity" style={{ background: ACCENT }}>
              <Plus className="w-4 h-4" /> Add
            </button>
          </form>
          {blocklistLoading ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : blocklist.length === 0 ? (
            <p className="text-sm text-gray-500">No blacklisted hotkeys.</p>
          ) : (
            <div className="border border-[#27272a] rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="text-left border-b border-[#27272a] bg-[#0f0f0f]">
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase">Hotkey</th>
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase w-24 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#27272a]">
                  {blocklist.map((hk) => (
                    <tr key={hk} className="hover:bg-[#1a1a1a]">
                      <td className="py-3 px-4 text-xs font-mono text-gray-300 break-all">{hk}</td>
                      <td className="py-3 px-4 text-right">
                        <button type="button" onClick={() => copyHotkey(hk)} className="p-1.5 text-gray-400 hover:text-white mr-1" title="Copy">
                          {copiedHotkey === hk ? <span className="text-[10px]" style={{ color: ACCENT }}>Copied</span> : <Copy className="w-4 h-4" />}
                        </button>
                        <button type="button" onClick={() => handleRemoveHotkey(hk)} className="p-1.5 text-gray-400 hover:text-red-400" title="Remove">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Add validator (admin only) */}
        <section className="glass-panel rounded-xl p-6 mb-8">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
            <ShieldCheck className="w-5 h-5" style={{ color: ACCENT }} />
            Validators
          </h2>
          {validatorError && <p className="text-sm text-red-400 mb-3">{validatorError}</p>}
          <form onSubmit={handleAddValidator} className="flex flex-wrap gap-3 mb-4">
            <input
              type="number"
              min={0}
              value={validatorForm.uid}
              onChange={(e) => setValidatorForm((f) => ({ ...f, uid: e.target.value }))}
              placeholder="UID (chain)"
              className="w-24 px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500 focus:border-[#333] focus:outline-none"
            />
            <input
              type="text"
              value={validatorForm.hotkey}
              onChange={(e) => setValidatorForm((f) => ({ ...f, hotkey: e.target.value }))}
              placeholder="Validator hotkey"
              className="flex-1 min-w-[200px] px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500 focus:border-[#333] focus:outline-none"
            />
            <input
              type="text"
              value={validatorForm.stake}
              onChange={(e) => setValidatorForm((f) => ({ ...f, stake: e.target.value }))}
              placeholder="Stake (optional)"
              className="w-24 px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500"
            />
            <input
              type="text"
              value={validatorForm.s3_bucket}
              onChange={(e) => setValidatorForm((f) => ({ ...f, s3_bucket: e.target.value }))}
              placeholder="S3 bucket (optional)"
              className="flex-1 min-w-[120px] px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500"
            />
            <button type="submit" disabled={validatorSubmitting} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-[#07080A] hover:opacity-90 disabled:opacity-50" style={{ background: ACCENT }}>
              <Plus className="w-4 h-4" /> Add validator
            </button>
          </form>
          {validators.length > 0 && (
            <div className="border border-[#27272a] rounded-lg overflow-hidden mt-4">
              <table className="w-full">
                <thead>
                  <tr className="text-left border-b border-[#27272a] bg-[#0f0f0f]">
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase">UID</th>
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase">Hotkey</th>
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase">Stake</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#27272a]">
                  {validators.map((v) => (
                    <tr key={v.uid} className="hover:bg-[#1a1a1a]">
                      <td className="py-3 px-4 text-xs text-gray-300">{v.uid}</td>
                      <td className="py-3 px-4 text-xs font-mono text-gray-300 break-all">{v.hotkey}</td>
                      <td className="py-3 px-4 text-xs text-gray-400">{v.stake}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Registered users (website, local DB) */}
        <section className="glass-panel rounded-xl p-6 mb-8">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
            <Users className="w-5 h-5" style={{ color: ACCENT }} />
            Registered users
          </h2>
          {usersError && <p className="text-sm text-red-400 mb-3">{usersError}</p>}
          {usersLoading ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : registeredUsers.length === 0 ? (
            <p className="text-sm text-gray-500">No registered users yet.</p>
          ) : (
            <div className="border border-[#27272a] rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="text-left border-b border-[#27272a] bg-[#0f0f0f]">
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase">Email</th>
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase">Name</th>
                    <th className="py-2 px-4 text-[10px] font-semibold text-gray-500 uppercase">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#27272a]">
                  {registeredUsers.map((u) => (
                    <tr key={u.id} className="hover:bg-[#1a1a1a]">
                      <td className="py-3 px-4 text-xs text-gray-300">{u.email}</td>
                      <td className="py-3 px-4 text-xs text-gray-400">{u.name || '—'}</td>
                      <td className="py-3 px-4 text-xs text-gray-500">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Blog posts */}
        <section className="glass-panel rounded-xl p-6">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
            <FileText className="w-5 h-5" style={{ color: ACCENT }} />
            Blog posts
          </h2>
          {postsError && <p className="text-sm text-red-400 mb-3">{postsError}</p>}
          {!showPostForm ? (
            <button
              type="button"
              onClick={() => setShowPostForm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium mb-4 text-[#07080A] hover:opacity-90"
              style={{ background: ACCENT }}
            >
              <Plus className="w-4 h-4" /> New post
            </button>
          ) : (
            <form onSubmit={handleCreatePost} className="mb-6 p-4 rounded-xl border border-[#27272a] bg-[#0a0a0a] space-y-4">
              <h3 className="text-sm font-medium text-white">New post</h3>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Title</label>
                <input
                  required
                  value={postForm.title}
                  onChange={(e) => setPostForm((p) => ({ ...p, title: e.target.value }))}
                  className="w-full px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm"
                  placeholder="Post title"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Excerpt (short summary)</label>
                <textarea
                  required
                  value={postForm.excerpt}
                  onChange={(e) => setPostForm((p) => ({ ...p, excerpt: e.target.value }))}
                  rows={2}
                  className="w-full px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500 resize-y"
                  placeholder="Brief excerpt for listing"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Category</label>
                  <input
                    value={postForm.category}
                    onChange={(e) => setPostForm((p) => ({ ...p, category: e.target.value }))}
                    className="w-full px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm"
                    placeholder="e.g. Technical, Roadmap"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Read time</label>
                  <input
                    value={postForm.read_time}
                    onChange={(e) => setPostForm((p) => ({ ...p, read_time: e.target.value }))}
                    className="w-full px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm"
                    placeholder="5 min read"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Image (upload or URL)</label>
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[#27272a] text-gray-400 hover:text-white cursor-pointer text-sm">
                    <ImagePlus className="w-4 h-4" />
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setImageFile(f);
                      }}
                    />
                    {imageFile ? imageFile.name : 'Upload'}
                  </label>
                  <input
                    type="text"
                    value={postForm.image}
                    onChange={(e) => setPostForm((p) => ({ ...p, image: e.target.value }))}
                    className="flex-1 min-w-[120px] px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500"
                    placeholder="Or paste image URL"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Content (plain text or markdown; styles applied on blog)</label>
                <textarea
                  required
                  value={postForm.content}
                  onChange={(e) => setPostForm((p) => ({ ...p, content: e.target.value }))}
                  rows={10}
                  className="w-full px-4 py-2 rounded-lg bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500 resize-y font-mono"
                  placeholder="Write your post content here. Paragraphs and line breaks are preserved."
                />
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={postForm.featured}
                    onChange={(e) => setPostForm((p) => ({ ...p, featured: e.target.checked }))}
                    className="rounded border-[#27272a] bg-[#0f0f0f]"
                  />
                  Featured
                </label>
                <div className="flex gap-2">
                  <button type="submit" disabled={submitting} className="px-4 py-2 rounded-lg text-sm font-medium text-[#07080A] disabled:opacity-50" style={{ background: ACCENT }}>
                    {submitting ? 'Saving...' : 'Publish'}
                  </button>
                  <button type="button" onClick={() => setShowPostForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white border border-[#27272a]">
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          )}
          {postsLoading ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : posts.length === 0 ? (
            <p className="text-sm text-gray-500">No posts yet.</p>
          ) : (
            <ul className="space-y-2">
              {posts.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-3 px-4 rounded-lg border border-[#27272a] hover:bg-[#1a1a1a]">
                  <span className="text-sm text-white font-medium truncate flex-1 mr-4">{p.title}</span>
                  <span className="text-xs text-gray-500 shrink-0 mr-4">{p.date}</span>
                  <button type="button" onClick={() => handleDeletePost(p.id)} className="p-1.5 text-gray-400 hover:text-red-400" title="Delete">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
