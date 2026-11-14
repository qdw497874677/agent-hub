import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { groupApi, type GroupPostDto } from '../shell/api.ts';
import { errorText } from '../shell/admin/shared.tsx';
import { toggleReaction, type MyName } from './group-live.ts';

/**
 * 帖子上的表情反应——唯一知道接口怎么调的地方。
 *
 * 点下去先改 posts 缓存（立刻有反应），失败回滚并把原因挂到那条帖子上；
 * 成功后以服务端返回的聚合值为准再让查询自己重拉（不整页刷新）。
 * 界面只拿 `reactTo` 和 `error`，`key` 是消息页 `['groups']` 这棵查询树的根。
 */
export function useReactions({ groupId, me, key }: { readonly groupId: string; readonly me: MyName; readonly key: readonly unknown[] }) {
  const client = useQueryClient();
  const postsKey = [...key, 'posts', groupId];
  const [error, setError] = useState<{ postId: string; message: string } | null>(null);

  const mutation = useMutation({
    mutationFn: (v: { postId: string; emoji: string; action: 'add' | 'remove' }) =>
      v.action === 'add' ? groupApi.react(groupId, v.postId, v.emoji) : groupApi.unreact(groupId, v.postId, v.emoji),
    onMutate: async (v) => {
      await client.cancelQueries({ queryKey: postsKey });
      const before = client.getQueryData<{ posts: GroupPostDto[] }>(postsKey);
      const target = before?.posts.find((post) => post.id === v.postId);
      if (before && target) {
        const { reactions } = toggleReaction(target.reactions, v.emoji, me);
        client.setQueryData(postsKey, { posts: before.posts.map((post) => (post.id === v.postId ? { ...post, reactions } : post)) });
      }
      return { before };
    },
    onError: (failure, v, context) => {
      if (context?.before) client.setQueryData(postsKey, context.before);
      setError({ postId: v.postId, message: errorText(failure) });
    },
    onSuccess: (data, v) => {
      client.setQueryData<{ posts: GroupPostDto[] }>(postsKey, (current) =>
        current ? { posts: current.posts.map((post) => (post.id === v.postId ? { ...post, reactions: data.reactions } : post)) } : current
      );
      setError(null);
      void client.invalidateQueries({ queryKey: postsKey });
    }
  });

  /** 点一下：我点过就撤，没点过就加（动作由当前缓存算，和界面看到的一致）。 */
  const reactTo = (post: GroupPostDto, emoji: string) => {
    const { action } = toggleReaction(post.reactions, emoji, me);
    setError(null);
    mutation.mutate({ postId: post.id, emoji, action });
  };

  return { reactTo, error };
}
