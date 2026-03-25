import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LogOut,
  User,
  History,
  Settings,
  CreditCard,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);

  if (!user) return null;

  const handleLogout = () => {
    logout();
    setIsOpen(false);
    navigate('/');
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-white/10 transition-colors">
          <Avatar className="w-8 h-8">
            <AvatarImage src={user.picture} alt={user.name} />
            <AvatarFallback className="bg-[#DFFF00] text-[#07080A] text-xs font-semibold">
              {getInitials(user.name)}
            </AvatarFallback>
          </Avatar>
          <ChevronDown size={16} className="text-[#A7B0B7]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56 bg-[#0D1117] border border-white/10"
      >
        <DropdownMenuLabel className="text-white">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium">{user.name}</p>
            <p className="text-xs text-[#A7B0B7]">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-white/10" />
        <DropdownMenuItem
          onClick={() => {
            navigate('/account');
            setIsOpen(false);
          }}
          className="text-white hover:bg-white/10 cursor-pointer"
        >
          <User size={16} className="mr-2" />
          My Account
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            navigate('/history');
            setIsOpen(false);
          }}
          className="text-white hover:bg-white/10 cursor-pointer"
        >
          <History size={16} className="mr-2" />
          History
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            navigate('/account/credits');
            setIsOpen(false);
          }}
          className="text-white hover:bg-white/10 cursor-pointer"
        >
          <CreditCard size={16} className="mr-2" />
          Credits: {user.credits}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-white/10" />
        <DropdownMenuItem
          onClick={() => {
            navigate('/account/settings');
            setIsOpen(false);
          }}
          className="text-white hover:bg-white/10 cursor-pointer"
        >
          <Settings size={16} className="mr-2" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-white/10" />
        <DropdownMenuItem
          onClick={handleLogout}
          className="text-red-400 hover:bg-red-400/10 cursor-pointer"
        >
          <LogOut size={16} className="mr-2" />
          Log Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

