import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('jobs')
export class JobEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  username: string;

  @Column({ default: 'pending' }) // pending | success | error
  status: string;

  @Column({ nullable: true })
  error?: string;

  @CreateDateColumn()
  createdAt: Date;
}
