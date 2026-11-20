import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { DATE_RE } from '../schedule/schedule.dto';

const DATE_MSG = { message: 'التاريخ بصيغة YYYY-MM-DD' };
const QTY = { maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false };

export class CreateSupplierDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  /** اللي علينا للمورد قبل ما يبدي النظام (دينار) */
  @IsOptional() @IsInt() @Min(0) opening_balance?: number;
  @IsOptional() @IsInt() branch_id?: number;
}
export class UpdateSupplierDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  /** يتعدل بس لحد أول حركة (فاتورة أو تسديد أو مرتجع) */
  @IsOptional() @IsInt() @Min(0) opening_balance?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class SupplierPaymentDto {
  @IsInt() @Min(1) amount: number;
  @IsIn(['safe', 'electronic']) pay_source: 'safe' | 'electronic';
  @IsOptional() @IsString() @MaxLength(100) bank_name?: string;
  @Matches(DATE_RE, DATE_MSG) paid_on: string;
  /** صورة إثبات اختيارية: مرفق من نوع supplier_payment_proof */
  @IsOptional() @IsInt() proof_attachment_id?: number;
}

export class PurchaseItemDto {
  @IsInt() material_id: number;
  /** الكمية بوحدة الشراء (كراتين) */
  @IsNumber(QTY) @Min(0.001) @Max(1_000_000) qty_pack: number;
  /** إجمالي سطر الفاتورة (دينار) */
  @IsInt() @Min(0) line_total: number;
  @Matches(DATE_RE, DATE_MSG) expiry_date: string;
}
export class PurchasePaymentDto {
  /** full: مدفوعة كاملة · credit: آجلة · partial: جزء الآن والباقي آجل */
  @IsIn(['full', 'credit', 'partial']) mode: 'full' | 'credit' | 'partial';
  @IsOptional() @IsInt() @Min(1) amount?: number;
  @IsOptional() @IsIn(['safe', 'electronic']) pay_source?: 'safe' | 'electronic';
  @IsOptional() @IsString() @MaxLength(100) bank_name?: string;
}
export class CreatePurchaseDto {
  @IsInt() supplier_id: number;
  @IsOptional() @IsString() @MaxLength(60) invoice_no?: string;
  @Matches(DATE_RE, DATE_MSG) purchase_date: string;
  /** صورة الوصل (إلزامية): مرفق من نوع purchase_receipt */
  @IsInt() receipt_attachment_id: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => PurchaseItemDto) items: PurchaseItemDto[];
  @IsDefined() @ValidateNested() @Type(() => PurchasePaymentDto) payment: PurchasePaymentDto;
}
export class VoidPurchaseDto {
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
}

export class ReturnItemDto {
  @IsInt() purchase_item_id: number;
  /** الكمية المرجعة بوحدة الاستهلاك */
  @IsNumber(QTY) @Min(0.001) @Max(1_000_000_000) qty_base: number;
}
export class CreateReturnDto {
  @IsInt() purchase_id: number;
  @IsString() @MinLength(3) @MaxLength(300) reason: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ReturnItemDto) items: ReturnItemDto[];
}
