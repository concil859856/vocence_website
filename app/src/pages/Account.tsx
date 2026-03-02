import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  User,
  CreditCard,
  Settings,
  ArrowLeft,
  Mail,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '../components/ui/avatar';

export function Account() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'profile';

  useEffect(() => {
    if (!user) {
      navigate('/');
    }
  }, [user, navigate]);

  if (!user) return null;

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-12 px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-3xl font-semibold">My Account</h1>
            <p className="text-[#A7B0B7]">Manage your account settings and preferences</p>
          </div>
        </div>

        {/* Profile Card */}
        <div className="card-vocence p-6 mb-6">
          <div className="flex items-center gap-6">
            <Avatar className="w-20 h-20">
              <AvatarImage src={user.picture} alt={user.name} />
              <AvatarFallback className="bg-[#DFFF00] text-[#07080A] text-2xl font-semibold">
                {getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <h2 className="text-2xl font-semibold mb-1">{user.name}</h2>
              <p className="text-[#A7B0B7] mb-4">{user.email}</p>
              <div className="flex items-center gap-6">
                <div>
                  <p className="text-xs text-[#666] mb-1">Credits</p>
                  <p className="text-xl font-bold text-[#DFFF00]">{user.credits}</p>
                </div>
                <div>
                  <p className="text-xs text-[#666] mb-1">Member Since</p>
                  <p className="text-sm text-[#A7B0B7]">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue={initialTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3 bg-[#0D1117] border border-white/10">
            <TabsTrigger value="profile" className="data-[state=active]:bg-white/10">
              <User size={16} className="mr-2" />
              Profile
            </TabsTrigger>
            <TabsTrigger value="credits" className="data-[state=active]:bg-white/10">
              <CreditCard size={16} className="mr-2" />
              Credits
            </TabsTrigger>
            <TabsTrigger value="settings" className="data-[state=active]:bg-white/10">
              <Settings size={16} className="mr-2" />
              Settings
            </TabsTrigger>
          </TabsList>

          {/* Profile Tab */}
          <TabsContent value="profile" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-4">Profile Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="label-mono mb-2 block">Name</label>
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 flex items-center gap-3">
                      <User size={18} className="text-[#666]" />
                      <span className="text-white">{user.name}</span>
                    </div>
                  </div>
                  <div>
                    <label className="label-mono mb-2 block">Email</label>
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 flex items-center gap-3">
                      <Mail size={18} className="text-[#666]" />
                      <span className="text-white">{user.email}</span>
                    </div>
                    <p className="text-xs text-[#666] mt-2">
                      Email is managed through your Google account
                    </p>
                  </div>
                  <div>
                    <label className="label-mono mb-2 block">Profile Picture</label>
                    <div className="flex items-center gap-4">
                      <Avatar className="w-16 h-16">
                        <AvatarImage src={user.picture} alt={user.name} />
                        <AvatarFallback className="bg-[#DFFF00] text-[#07080A]">
                          {getInitials(user.name)}
                        </AvatarFallback>
                      </Avatar>
                      <p className="text-sm text-[#A7B0B7]">
                        Profile picture is managed through your Google account
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Credits Tab */}
          <TabsContent value="credits" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-4">Credit Balance</h3>
                <div className="bg-gradient-to-br from-[#DFFF00]/20 to-[#2E7D32]/20 border border-[#DFFF00]/30 rounded-2xl p-8 text-center mb-6">
                  <div className="text-5xl font-bold text-[#DFFF00] mb-2">
                    {user.credits}
                  </div>
                  <p className="text-[#A7B0B7]">Available Credits</p>
                </div>

                <div className="space-y-4">
                  <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
                    <h4 className="font-medium mb-2">How Credits Work</h4>
                    <ul className="text-sm text-[#A7B0B7] space-y-1 list-disc list-inside">
                      <li>Text-to-Speech: 10 credits per generation</li>
                      <li>Speech-to-Text: 2 credits per transcription</li>
                      <li>Voice Cloning: 10 credits per clone</li>
                      <li>Voice Chat: 0.5 credits per message</li>
                    </ul>
                  </div>

                  <button className="btn-primary w-full">
                    <CreditCard size={16} className="mr-2" />
                    Purchase Credits
                  </button>
                </div>
              </div>

              {/* Transaction History */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Recent Transactions</h3>
                <div className="space-y-2">
                  {[
                    { type: 'Purchase', amount: '+100', date: '2 days ago' },
                    { type: 'TTS Generation', amount: '-1', date: '1 day ago' },
                    { type: 'Voice Clone', amount: '-10', date: '3 days ago' },
                  ].map((transaction, index) => (
                    <div
                      key={index}
                      className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium">{transaction.type}</p>
                        <p className="text-xs text-[#666]">{transaction.date}</p>
                      </div>
                      <span
                        className={`font-mono ${
                          transaction.amount.startsWith('+')
                            ? 'text-green-400'
                            : 'text-red-400'
                        }`}
                      >
                        {transaction.amount}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-4">Account Settings</h3>
                <div className="space-y-4">
                  <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
                    <h4 className="font-medium mb-2">Notifications</h4>
                    <p className="text-sm text-[#A7B0B7] mb-4">
                      Manage how you receive notifications
                    </p>
                    <div className="space-y-3">
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="text-sm">Email notifications</span>
                        <input type="checkbox" className="w-4 h-4 rounded" defaultChecked />
                      </label>
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="text-sm">Credit balance alerts</span>
                        <input type="checkbox" className="w-4 h-4 rounded" defaultChecked />
                      </label>
                    </div>
                  </div>

                  <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
                    <h4 className="font-medium mb-2">Privacy</h4>
                    <p className="text-sm text-[#A7B0B7] mb-4">
                      Control your privacy settings
                    </p>
                    <div className="space-y-3">
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="text-sm">Public profile</span>
                        <input type="checkbox" className="w-4 h-4 rounded" />
                      </label>
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="text-sm">Share usage statistics</span>
                        <input type="checkbox" className="w-4 h-4 rounded" defaultChecked />
                      </label>
                    </div>
                  </div>

                  <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                    <h4 className="font-medium mb-2 text-red-400">Danger Zone</h4>
                    <p className="text-sm text-[#A7B0B7] mb-4">
                      Irreversible and destructive actions
                    </p>
                    <button className="btn-outline text-red-400 border-red-500/20 hover:border-red-500/40">
                      Delete Account
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

