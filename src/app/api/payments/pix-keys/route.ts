import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { commerceErrorResponse, readJsonBody } from '@/lib/commerce/http';
import { RepositoryError } from '@/lib/commerce/products.repo';
import { ValidationError } from '@/lib/commerce/validation';
import { normalizePixKey, type PixKeyType } from '@/services/payments/dotfy';

const TIPOS: PixKeyType[] = ['cpf', 'cnpj', 'email', 'phone', 'random'];

/**
 * Chaves PIX estáticas.
 *
 * Vendedor LÊ (precisa copiar durante o atendimento), só master
 * ESCREVE — mudar a chave de recebimento é decisão do dono. Chave
 * PIX não é credencial: é dado que o cliente vai receber de
 * qualquer forma.
 */
export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    const { data, error } = await ctx.supabase
      .from('pix_keys')
      .select('id, label, key_type, key_value, holder_name, is_default, is_active')
      .eq('account_id', ctx.accountId)
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw new RepositoryError(error.message);
    return NextResponse.json({ keys: data ?? [] });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await readJsonBody(request)) as Record<string, unknown>;

    const label = String(body.label ?? '').trim();
    if (!label) throw new ValidationError('Nome da chave é obrigatório', 'label');
    if (label.length > 60) {
      throw new ValidationError('Nome muito longo', 'label');
    }

    if (!TIPOS.includes(body.key_type as PixKeyType)) {
      throw new ValidationError(
        'Tipo deve ser cpf, cnpj, email, phone ou random',
        'key_type'
      );
    }

    const tipo = body.key_type as PixKeyType;
    const resultado = normalizePixKey(tipo, String(body.key_value ?? ''));

    if (!resultado.ok) {
      throw new ValidationError(resultado.error, 'key_value');
    }

    const querPadrao = Boolean(body.is_default);

    // Só uma padrão por conta. O índice parcial recusaria a segunda,
    // mas devolver 409 seria confuso: o operador pediu para trocar,
    // não para duplicar. Rebaixar a anterior é o que ele quis dizer.
    if (querPadrao) {
      await ctx.supabase
        .from('pix_keys')
        .update({ is_default: false })
        .eq('account_id', ctx.accountId)
        .eq('is_default', true);
    }

    const { data, error } = await ctx.supabase
      .from('pix_keys')
      .insert({
        account_id: ctx.accountId,
        label,
        key_type: tipo,
        key_value: resultado.value,
        holder_name: String(body.holder_name ?? '').trim() || null,
        is_default: querPadrao,
        created_by_user_id: ctx.userId,
      })
      .select('id, label, key_type, key_value, holder_name, is_default')
      .single();

    if (error) throw new RepositoryError(error.message);

    await ctx.supabase.rpc('write_audit_log', {
      p_account_id: ctx.accountId,
      p_action: 'payments.pix_key_created',
      p_entity_type: 'pix_key',
      p_entity_id: data.id,
      // Sem o valor da chave: quem lê auditoria não precisa dela.
      p_metadata: { label, key_type: tipo },
    });

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return commerceErrorResponse(err);
  }
}
